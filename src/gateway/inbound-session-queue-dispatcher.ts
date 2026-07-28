// Authorized inbound serializer: wraps the already-authorized, route-resolved
// portion of `handleDingTalkMessage` with the promise-chain queue from
// `inbound-session-queue.ts`.
//
// The gateway intentionally does not call this module.  At the gateway boundary
// we only have raw accountId + conversationId, before DM/group policy, allowlist
// checks, special-command bypasses, and trusted agent routing.  Queueing there
// could acknowledge an unauthorized sender or block /stop and /btw.  The caller
// supplies the resolved route.sessionKey only after those decisions, so a message
// that arrives while the same real session is active is queued and reprocessed
// once the active run finishes instead of racing into the core's
//   "reply session initialization conflicted for <sessionKey>"
// and being dropped silently at the gateway catch block (the
// "钉钉'确认'消息无响应" regression.
//
// While a message is queued, a pre-created AI Card shows an immediate
// "已排队" acknowledgement; the handler later reuses that same card
// (`params.preCreatedCard`) to stream the real reply in place.
//
// Ported from DingTalk-Real-AI/dingtalk-openclaw-connector's session-queue
// orchestrator, adapted to soimy's blocking gateway contract (we await each
// task so the gateway's per-message dedup stays correct).

import { attachNativeAckReaction } from "../ack-reaction-service";
import {
  createAICard,
  isCardInTerminalState,
  recallAICardMessage,
  streamAICard,
} from "../card-service";
import {
  chainInboundSessionTask,
  getInboundSessionQueueDepth,
  InboundSessionQueueWaitTimeoutError,
  isInboundSessionQueueBusy,
  MAX_INBOUND_SESSION_QUEUE_DEPTH,
  MAX_INBOUND_SESSION_QUEUE_WAIT_MS,
  pickQueueBusyAckPhrase,
} from "./inbound-session-queue";
import { sendMessage } from "../send-service";
import type { AICardInstance, DingTalkConfig, DingTalkInboundMessage, Logger } from "../types";

export interface InboundQueueDispatchInput {
  accountId: string;
  data: DingTalkInboundMessage;
  dingtalkConfig: DingTalkConfig;
  /** Trusted route.sessionKey, resolved after access control. */
  sessionKey: string;
  /** Resolved DingTalk reply target for this authorized route. */
  to: string;
  storePath?: string;
  quoteContent?: string;
  log?: Logger;
}

const QUEUE_FULL_ACK = "当前消息较多，已达到本会话排队上限；请等待上一轮完成后再发送。";
const QUEUE_WAIT_TIMEOUT_ACK = "上一轮处理时间较长，这条消息未执行；请稍后重新发送。";
const QUEUE_HANDLER_FAILURE_ACK = "本次处理异常，未能完成；请稍后重新发送。";
const MIN_QUEUE_ACK_CARD_VISIBLE_MS = 750;

const queuedAckVisibleAt = new WeakMap<AICardInstance, number>();

function shouldPrepareQueueAckCard(input: InboundQueueDispatchInput): boolean {
  return input.dingtalkConfig.messageType === "card";
}

async function keepQueueAckCardVisible(card: AICardInstance): Promise<void> {
  const visibleAt = queuedAckVisibleAt.get(card);
  if (!visibleAt) {
    return;
  }
  const remainingMs = MIN_QUEUE_ACK_CARD_VISIBLE_MS - (Date.now() - visibleAt);
  if (remainingMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
  }
}

async function settleUnusedQueueAckCard(
  input: InboundQueueDispatchInput,
  card: AICardInstance,
): Promise<void> {
  if (isCardInTerminalState(card.state)) {
    return;
  }
  try {
    if (await recallAICardMessage(card, input.log)) {
      return;
    }
  } catch (err: unknown) {
    input.log?.warn?.(
      `[DingTalk] Failed to recall unused queue acknowledgement card: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await sendQueueTerminalAck(input, "已结束排队确认，请以本次实际回复为准。", card);
}

/**
 * A visible queue ACK promises that the message will be handled.  If the
 * queued continuation fails before consuming that card, finish it with a
 * retryable outcome instead of recalling the only user-visible feedback.
 */
async function settleFailedQueueAckCard(
  input: InboundQueueDispatchInput,
  card: AICardInstance,
): Promise<void> {
  if (isCardInTerminalState(card.state)) {
    return;
  }
  await sendQueueTerminalAck(input, QUEUE_HANDLER_FAILURE_ACK, card);
}

/**
 * Serialize an inbound message per conversation, then invoke `handler` (which
 * should call `handleDingTalkMessage` with the provided `preCreatedCard`).
 *
 * The returned promise settles with the handler's own outcome, so the caller
 * (gateway) can await it and keep its per-message dedup correct
 * (`markMessageProcessed` only runs once the message truly completes).
 */
export async function dispatchInboundViaSessionQueue<T>(
  input: InboundQueueDispatchInput,
  handler: (preCreatedCard?: AICardInstance) => Promise<T>,
): Promise<T> {
  const queueKey = input.sessionKey;
  if (!queueKey) {
    // A trusted route must include a session key. Keep this defensive fallback
    // for alternate callers rather than inventing a raw gateway-level key.
    return handler(undefined);
  }
  const wasBusy = isInboundSessionQueueBusy(queueKey);
  if (getInboundSessionQueueDepth(queueKey) >= MAX_INBOUND_SESSION_QUEUE_DEPTH) {
    await sendQueueTerminalAck(input, QUEUE_FULL_ACK);
    return undefined as T;
  }
  // Detect busyness BEFORE chaining: this call is "busy" only if a PRIOR task
  // for this conversation is still running.
  // Start preparing a busy ACK without awaiting it before we reserve a queue
  // slot below. Otherwise a burst of inbound messages can all observe the
  // same pre-await depth and each pass the cap check.
  let queuedAckState: "queued" | "timed-out" = "queued";
  const preCreatedCardPromise = wasBusy && shouldPrepareQueueAckCard(input)
    ? tryPrepareQueueAckCard(input, () =>
        queuedAckState === "timed-out"
          ? { content: QUEUE_WAIT_TIMEOUT_ACK, finished: true }
          : { content: pickQueueBusyAckPhrase(), finished: false },
      )
    : undefined;
  // Chain onto the prior task for this conversation and AWAIT. Awaiting (rather
  // than fire-and-forget) preserves the gateway's per-message dedup:
  // `markMessageProcessed` runs only after this message truly completes, so a
  // still-queued message is never marked processed.
  try {
    return await chainInboundSessionTask(
      queueKey,
      async () => {
        const preCreatedCard = preCreatedCardPromise
          ? await preCreatedCardPromise
          : undefined;
        if (!preCreatedCard) {
          return handler(undefined);
        }
        await keepQueueAckCardVisible(preCreatedCard);
        let handlerFailed = false;
        try {
          return await handler(preCreatedCard);
        } catch (err: unknown) {
          handlerFailed = true;
          await settleFailedQueueAckCard(input, preCreatedCard);
          throw err;
        } finally {
          if (!handlerFailed && !isCardInTerminalState(preCreatedCard.state)) {
            await settleUnusedQueueAckCard(input, preCreatedCard);
          }
        }
      },
      {
        maxQueueWaitMs: wasBusy ? MAX_INBOUND_SESSION_QUEUE_WAIT_MS : undefined,
      },
    );
  } catch (err: unknown) {
    if (err instanceof InboundSessionQueueWaitTimeoutError) {
      queuedAckState = "timed-out";
      await sendQueueTerminalAck(
        input,
        QUEUE_WAIT_TIMEOUT_ACK,
        preCreatedCardPromise ? await preCreatedCardPromise : undefined,
      );
      return undefined as T;
    }
    throw err;
  }
}

/**
 * Pre-create an AI Card showing a "已排队" acknowledgement for a message that
 * arrived while its conversation was busy. The handler later reuses this card
 * to stream the real reply in place. Best-effort: any failure returns
 * undefined and the handler falls back to creating a fresh card (or markdown).
 */
async function tryPrepareQueueAckCard(
  input: InboundQueueDispatchInput,
  ack: () => { content: string; finished: boolean },
): Promise<AICardInstance | undefined> {
  const { dingtalkConfig, data, log, to, storePath, quoteContent } = input;
  if (!data) {
    return undefined;
  }
  if (!to) {
    return undefined;
  }
  let card: AICardInstance | null = null;
  let ackFinished = false;
  try {
    card = await createAICard(dingtalkConfig, to, log, {
      accountId: input.accountId,
      storePath,
      quoteContent,
    });
    if (!card) {
      return undefined;
    }
    const { content, finished } = ack();
    ackFinished = finished;
    await streamAICard(card, content, finished, log, {
      recoveryAction: finished ? "finalize" : "recall",
    });
    if (!finished) {
      queuedAckVisibleAt.set(card, Date.now());
    }
    if (finished) {
      return card;
    }
    // Best-effort thinking reaction; failures must not block the queue.
    void attachNativeAckReaction(
      dingtalkConfig,
      { msgId: data.msgId, conversationId: data.conversationId },
      log,
    ).catch((err: unknown) => {
      log?.debug?.(
        `[DingTalk] Queue-busy ack reaction attach failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    log?.info?.(
      `[DingTalk] Inbound message queued behind active run for session=${input.sessionKey}; pre-created ACK card outTrackId=${card.cardInstanceId}.`,
    );
    return card;
  } catch (err: unknown) {
    if (card && !ackFinished) {
      try {
        await recallAICardMessage(card, log);
      } catch (recallErr: unknown) {
        log?.warn?.(
          `[DingTalk] Failed to recall queue ACK card after prepare failure: ${recallErr instanceof Error ? recallErr.message : String(recallErr)}`,
        );
      }
    }
    log?.warn?.(
      `[DingTalk] Queue-busy ACK card prepare failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

async function sendQueueTerminalAck(
  input: InboundQueueDispatchInput,
  content: string,
  preCreatedCard?: AICardInstance,
): Promise<void> {
  const { dingtalkConfig, data, log, to, storePath } = input;
  try {
    if (preCreatedCard) {
      try {
        await streamAICard(preCreatedCard, content, true, log);
        return;
      } catch (err: unknown) {
        log?.warn?.(
          `[DingTalk] Queue acknowledgement card finalization failed; falling back to text: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      const card = await tryPrepareQueueAckCard(input, () => ({ content, finished: true }));
      if (card) {
        return;
      }
    }
    if (!to) {
      return;
    }
    const result = await sendMessage(dingtalkConfig, to, content, {
      sessionWebhook: data.sessionWebhook,
      log,
      accountId: input.accountId,
      storePath,
      conversationId: data.conversationId,
    });
    if (!result.ok) {
      log?.warn?.(`[DingTalk] Queue terminal acknowledgement failed: ${result.error || "unknown"}`);
    }
  } catch (err: unknown) {
    log?.warn?.(
      `[DingTalk] Queue terminal acknowledgement delivery failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
