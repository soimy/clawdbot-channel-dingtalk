/**
 * End-to-end regression for the "钉钉'确认'消息无响应" incident, driven through
 * the REAL `handleDingTalkMessage`.
 *
 * Proves the ported per-conversation promise-chain queue
 * (DingTalk-Real-AI/dingtalk-openclaw-connector port):
 *  1. A message that arrives while another is still being processed is QUEUED
 *     (its core dispatch does not start until the active run finishes) — it is
 *     never dropped silently.
 *  2. While queued, a pre-created AI Card shows a "已排队" acknowledgement.
 *  3. Once the active run finishes, the queued message is auto-reprocessed
 *     (zero re-send required).
 *  4. The queued message reuses its pre-created card for the real reply
 *     (in-place update): no second card is created.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  isBtwRequestTextMock: vi.fn(),
  isAbortRequestTextMock: vi.fn(),
  extractMessageContentMock: vi.fn(),
  getRuntimeMock: vi.fn(),
  sendBySessionMock: vi.fn(),
  sendMessageMock: vi.fn(),
  dispatchMock: vi.fn(),
  createAICardMock: vi.fn(),
  commitAICardBlocksMock: vi.fn(),
  finishAICardMock: vi.fn(),
  isCardInTerminalStateMock: vi.fn(),
  recallAICardMessageMock: vi.fn(),
  streamAICardMock: vi.fn(),
  formatContentForCardMock: vi.fn((s: string) => s),
  extractAttachmentTextMock: vi.fn(),
  prepareMediaInputMock: vi.fn(),
  resolveOutboundMediaTypeMock: vi.fn(),
  downloadGroupFileMock: vi.fn(),
  getUnionIdByStaffIdMock: vi.fn(),
  resolveQuotedFileMock: vi.fn(),
  sendProactiveMediaMock: vi.fn(),
  deliverBtwReplyMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  isAbortRequestText: shared.isAbortRequestTextMock,
  isBtwRequestText: shared.isBtwRequestTextMock,
}));

vi.mock("../../src/messaging/btw-deliver", () => ({
  deliverBtwReply: shared.deliverBtwReplyMock,
  stripLeadingMentions: (text: string) => text.replace(/^(?:@\S+\s+)*/u, ""),
  buildBtwBlockquote: vi.fn(),
}));

vi.mock("../../src/auth", () => ({
  getAccessToken: vi.fn().mockResolvedValue("token_abc"),
}));

vi.mock("../../src/runtime", () => ({
  getDingTalkRuntime: shared.getRuntimeMock,
}));

vi.mock("../../src/message-utils", () => ({
  extractMessageContent: shared.extractMessageContentMock,
}));

vi.mock("../../src/messaging/attachment-text-extractor", () => ({
  extractAttachmentText: shared.extractAttachmentTextMock,
}));

vi.mock("../../src/send-service", () => ({
  sendBySession: shared.sendBySessionMock,
  sendMessage: shared.sendMessageMock,
  sendProactiveMedia: shared.sendProactiveMediaMock,
}));

vi.mock("../../src/media-utils", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/media-utils")>("../../src/media-utils");
  return {
    ...actual,
    prepareMediaInput: shared.prepareMediaInputMock,
    resolveOutboundMediaType: shared.resolveOutboundMediaTypeMock,
  };
});

vi.mock("../../src/card-service", () => ({
  createAICard: shared.createAICardMock,
  commitAICardBlocks: shared.commitAICardBlocksMock,
  finishAICard: shared.finishAICardMock,
  formatContentForCard: shared.formatContentForCardMock,
  isCardInTerminalState: shared.isCardInTerminalStateMock,
  recallAICardMessage: shared.recallAICardMessageMock,
  streamAICard: shared.streamAICardMock,
}));

vi.mock("../../src/message-context-store", async () => {
  const actual = await vi.importActual<typeof import("../../src/message-context-store")>(
    "../../src/message-context-store",
  );
  return {
    ...actual,
    upsertInboundMessageContext: vi.fn(actual.upsertInboundMessageContext),
    resolveByMsgId: vi.fn(actual.resolveByMsgId),
    resolveByAlias: vi.fn(actual.resolveByAlias),
    resolveByCreatedAtWindow: vi.fn(actual.resolveByCreatedAtWindow),
    clearMessageContextCacheForTest: vi.fn(actual.clearMessageContextCacheForTest),
  };
});

vi.mock("../../src/messaging/quoted-file-service", () => ({
  downloadGroupFile: shared.downloadGroupFileMock,
  getUnionIdByStaffId: shared.getUnionIdByStaffIdMock,
  resolveQuotedFile: shared.resolveQuotedFileMock,
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearCardRunRegistryForTest } from "../../src/card/card-run-registry";
// NOTE: inbound-session-queue, session-lock, and reply-session-conflict are NOT
// mocked — we exercise the real promise-chain serializer + real per-session lock.
import { handleDingTalkMessage } from "../../src/inbound-handler";
import { resetProactivePermissionHintStateForTest } from "../../src/inbound-handler";
import {
  chainInboundSessionTask,
  MAX_INBOUND_SESSION_QUEUE_DEPTH,
  MAX_INBOUND_SESSION_QUEUE_WAIT_MS,
  QUEUE_BUSY_ACK_PHRASES,
  resetInboundSessionQueueForTest,
} from "../../src/inbound-session-queue";
import { dispatchInboundViaSessionQueue } from "../../src/inbound-session-queue-dispatcher";
import * as messageContextStore from "../../src/message-context-store";
import { clearTargetDirectoryStateCache } from "../../src/targeting/target-directory-store";

const TEST_TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-queue-int-"));
const STORE_PATH = path.join(TEST_TMP_DIR, "store-queue.json");
const SESSION_KEY = "agent:main:dingtalk:direct:user-queue";

function buildRuntime() {
  return {
    channel: {
      routing: {
        resolveAgentRoute: vi.fn().mockReturnValue({
          agentId: "main",
          sessionKey: SESSION_KEY,
          mainSessionKey: SESSION_KEY,
        }),
        buildAgentSessionKey: vi.fn().mockReturnValue("agent-session-key"),
      },
      media: {
        saveMediaBuffer: vi
          .fn()
          .mockResolvedValue({ path: "/tmp/m.png", contentType: "image/png" }),
      },
      session: {
        resolveStorePath: vi.fn().mockReturnValue(STORE_PATH),
        readSessionUpdatedAt: vi.fn().mockReturnValue(null),
        recordInboundSession: vi.fn().mockResolvedValue(undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
        formatInboundEnvelope: vi.fn().mockReturnValue("body"),
        finalizeInboundContext: vi.fn().mockReturnValue({ SessionKey: SESSION_KEY }),
        dispatchReplyWithBufferedBlockDispatcher: shared.dispatchMock,
      },
    },
  };
}

let cardSerial = 0;
function buildMessage(text: string, msgId: string) {
  return {
    cfg: {},
    accountId: "main",
    inboundOrigin: "stream",
    inboundQueueEligible: true,
    sessionWebhook: `https://session.webhook/${msgId}`,
    log: undefined,
    dingtalkConfig: { dmPolicy: "open", clientId: "robot_x", messageType: "card" } as any,
    data: {
      msgId,
      msgtype: "text",
      text: { content: text },
      conversationType: "1",
      conversationId: "cid_queue_1",
      senderId: "user-queue",
      senderNick: "排队用户",
      chatbotUserId: "bot_1",
      sessionWebhook: `https://session.webhook/${msgId}`,
      createAt: Date.now(),
    },
  } as any;
}

// Real stream messages now enter the queue inside handleDingTalkMessage, after
// access control and route.sessionKey resolution. Gateway only invokes handler.
function dispatch(msg: any): Promise<void> {
  return handleDingTalkMessage(msg);
}

function queueInput(msg: any) {
  return {
    accountId: msg.accountId,
    data: msg.data,
    dingtalkConfig: msg.dingtalkConfig,
    sessionKey: SESSION_KEY,
    to: msg.data.senderId,
    storePath: STORE_PATH,
    quoteContent: msg.data.text.content,
    log: msg.log,
  };
}

describe('inbound session queue (钉钉"确认"无响应 regression)', () => {
  beforeEach(() => {
    clearTargetDirectoryStateCache();
    fs.rmSync(path.join(TEST_TMP_DIR, "dingtalk-state"), { recursive: true, force: true });

    shared.sendBySessionMock.mockReset();
    shared.sendBySessionMock.mockResolvedValue({ ok: true });
    shared.sendMessageMock.mockReset();
    shared.sendMessageMock.mockResolvedValue({ ok: true });
    shared.dispatchMock.mockReset();
    shared.extractMessageContentMock.mockReset();
    shared.isAbortRequestTextMock.mockReset();
    shared.isAbortRequestTextMock.mockReturnValue(false);
    shared.isBtwRequestTextMock.mockReset();
    shared.isBtwRequestTextMock.mockReturnValue(false);
    shared.createAICardMock.mockReset();
    shared.commitAICardBlocksMock.mockReset();
    shared.commitAICardBlocksMock.mockResolvedValue(undefined);
    shared.finishAICardMock.mockReset();
    shared.finishAICardMock.mockResolvedValue(undefined);
    shared.isCardInTerminalStateMock.mockReset();
    shared.recallAICardMessageMock.mockReset();
    shared.recallAICardMessageMock.mockResolvedValue(true);
    shared.streamAICardMock.mockReset();
    shared.streamAICardMock.mockResolvedValue(undefined);
    shared.extractAttachmentTextMock.mockReset();
    shared.extractAttachmentTextMock.mockResolvedValue(null);
    shared.prepareMediaInputMock.mockReset();
    shared.resolveOutboundMediaTypeMock.mockReset();
    shared.resolveOutboundMediaTypeMock.mockReturnValue("file");
    shared.downloadGroupFileMock.mockReset();
    shared.downloadGroupFileMock.mockResolvedValue(null);
    shared.getUnionIdByStaffIdMock.mockReset();
    shared.getUnionIdByStaffIdMock.mockResolvedValue("union_1");
    shared.resolveQuotedFileMock.mockReset();
    shared.resolveQuotedFileMock.mockResolvedValue(null);
    shared.sendProactiveMediaMock.mockReset();
    shared.deliverBtwReplyMock.mockReset();
    shared.deliverBtwReplyMock.mockResolvedValue(undefined);
    shared.getRuntimeMock.mockReturnValue(buildRuntime());
    resetProactivePermissionHintStateForTest();
    clearCardRunRegistryForTest();
    messageContextStore.clearMessageContextCacheForTest();
    resetInboundSessionQueueForTest();
    cardSerial = 0;
  });

  afterEach(() => {
    resetInboundSessionQueueForTest();
    vi.useRealTimers();
  });

  it("queues a busy message, acks it on a pre-created card, then auto-reprocesses it (no drop, in-place card)", async () => {
    let resolveFirstDispatchStarted: () => void = () => {};
    const firstDispatchStarted = new Promise<void>((resolve) => {
      resolveFirstDispatchStarted = resolve;
    });
    let resolveQueuedAckStreamed: () => void = () => {};
    const queuedAckStreamed = new Promise<void>((resolve) => {
      resolveQueuedAckStreamed = resolve;
    });
    let queuedAckVisibleAt = 0;
    let queuedDispatchStartedAt = 0;
    // Each createAICard call yields a distinct fake card so we can tell the
    // active run's card apart from the queued message's ACK card.
    shared.createAICardMock.mockImplementation(async () => ({
      cardInstanceId: `card_${(cardSerial += 1)}`,
      outTrackId: `card_${cardSerial}`,
      state: "INPUTING",
      storePath: STORE_PATH,
      lastStreamedContent: "",
      lastUpdated: Date.now(),
    }));
    shared.isCardInTerminalStateMock.mockReturnValue(false);
    shared.streamAICardMock.mockImplementation(async (_card: unknown, content: string) => {
      if ((QUEUE_BUSY_ACK_PHRASES as readonly string[]).includes(content)) {
        queuedAckVisibleAt = Date.now();
        resolveQueuedAckStreamed();
      }
    });
    shared.extractMessageContentMock.mockImplementation((data: any) => ({
      text: data?.text?.content,
      messageType: "text",
    }));

    // A's core dispatch hangs on a gate to simulate a long active run.
    let resolveADispatch: () => void = () => {};
    const aDispatchGate = new Promise<void>((resolve) => {
      resolveADispatch = resolve;
    });
    let dispatchCallCount = 0;
    shared.dispatchMock.mockImplementation(() => {
      dispatchCallCount += 1;
      if (dispatchCallCount === 1) {
        resolveFirstDispatchStarted();
        // A: hang until the test releases it.
        return aDispatchGate.then(() => ({ queuedFinal: undefined }));
        }
        // B (and beyond): resolve immediately.
        queuedDispatchStartedAt = Date.now();
        return Promise.resolve({ queuedFinal: undefined });
    });

    // A arrives first on an idle queue → runs immediately.
    const aPromise = dispatch(buildMessage("查询A", "msg_a"));
    // Wait on the actual handler call rather than timer polling: this is
    // stable under CI worker contention.
    await firstDispatchStarted;

    // While A is still running, B arrives on the SAME conversation.
    const bPromise = dispatch(buildMessage("确认", "msg_b"));
    await queuedAckStreamed;

    // Assertion 1: B is QUEUED — its core dispatch has NOT started while A runs.
    expect(shared.dispatchMock).toHaveBeenCalledTimes(1);

    // Assertion 2: B's ACK was streamed onto a pre-created card with a
    // queue-busy acknowledgement phrase.
    const ackStreamCalls = shared.streamAICardMock.mock.calls.filter((call: any[]) =>
      (QUEUE_BUSY_ACK_PHRASES as readonly string[]).includes(call[1]),
    );
    expect(ackStreamCalls.length).toBe(1);

    // Now release A's long-running dispatch.
    resolveADispatch();
    await Promise.all([aPromise, bPromise]);

    // Assertion 3: B was auto-reprocessed after A finished — its dispatch ran.
    // Total dispatch calls = 2 (A then B), in order.
    expect(shared.dispatchMock).toHaveBeenCalledTimes(2);
    expect(queuedDispatchStartedAt - queuedAckVisibleAt).toBeGreaterThanOrEqual(700);

    // Assertion 4: B reused its pre-created ACK card — createAICard was called
    // exactly twice (A's real card + B's ACK card), NOT three times (B did not
    // create a second real card; it streamed its reply into the ACK card).
    expect(shared.createAICardMock).toHaveBeenCalledTimes(2);
    // The 2nd createAICard call is B's ACK card, prepared from the inbound
    // "确认" text (quoteContent). Use find() to be tolerant of the `log`
    // argument being undefined (expect.anything() rejects undefined).
    const bAckCreateCall = shared.createAICardMock.mock.calls.find(
      (call: any[]) => call[3]?.quoteContent === "确认",
    );
    expect(bAckCreateCall).toBeTruthy();
  });

  it("expires a queued message with a terminal card update without running its handler", async () => {
    let resolveFirstDispatchStarted: () => void = () => {};
    const firstDispatchStarted = new Promise<void>((resolve) => {
      resolveFirstDispatchStarted = resolve;
    });
    let resolveQueuedAckStreamed: () => void = () => {};
    const queuedAckStreamed = new Promise<void>((resolve) => {
      resolveQueuedAckStreamed = resolve;
    });
    shared.createAICardMock.mockImplementation(async () => ({
      cardInstanceId: `card_${(cardSerial += 1)}`,
      outTrackId: `card_${cardSerial}`,
      state: "INPUTING",
      storePath: STORE_PATH,
      lastStreamedContent: "",
      lastUpdated: Date.now(),
    }));
    shared.isCardInTerminalStateMock.mockReturnValue(false);
    shared.streamAICardMock.mockImplementation(async (_card: unknown, content: string) => {
      if ((QUEUE_BUSY_ACK_PHRASES as readonly string[]).includes(content)) {
        resolveQueuedAckStreamed();
      }
    });
    shared.extractMessageContentMock.mockImplementation((data: any) => ({
      text: data?.text?.content,
      messageType: "text",
    }));
    vi.useFakeTimers({ toFake: ["setTimeout"] });

    let resolveADispatch: () => void = () => {};
    const aDispatchGate = new Promise<void>((resolve) => {
      resolveADispatch = resolve;
    });
    shared.dispatchMock.mockImplementation(() => {
      resolveFirstDispatchStarted();
      return aDispatchGate.then(() => ({ queuedFinal: undefined }));
    });

    const aPromise = dispatch(buildMessage("查询A", "msg_timeout_a"));
    await firstDispatchStarted;
    const bPromise = dispatch(buildMessage("确认", "msg_timeout_b"));
    await queuedAckStreamed;

    await vi.advanceTimersByTimeAsync(MAX_INBOUND_SESSION_QUEUE_WAIT_MS);
    await bPromise;

    expect(shared.dispatchMock).toHaveBeenCalledTimes(1);
    const timeoutUpdate = shared.streamAICardMock.mock.calls.find(
      (call: any[]) => call[1].includes("这条消息未执行") && call[2] === true,
    );
    expect(timeoutUpdate).toBeTruthy();

    resolveADispatch();
    await aPromise;
    // The expired task stays in the serialized tail only long enough to skip
    // itself; it must never dispatch after the active run finishes.
    expect(shared.dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a message beyond the per-conversation depth cap without invoking its handler", async () => {
    shared.createAICardMock.mockResolvedValue(null);
    let releaseActive: () => void = () => {};
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const queued = [chainInboundSessionTask(SESSION_KEY, () => activeGate)];
    for (let index = 1; index < MAX_INBOUND_SESSION_QUEUE_DEPTH; index += 1) {
      queued.push(chainInboundSessionTask(SESSION_KEY, async () => undefined));
    }
    const rejectedHandler = vi.fn(async () => undefined);
    await dispatchInboundViaSessionQueue(
      queueInput(buildMessage("确认", "msg_queue_full")),
      rejectedHandler,
    );

    expect(rejectedHandler).not.toHaveBeenCalled();
    expect(shared.sendMessageMock).toHaveBeenCalledTimes(1);
    expect(shared.sendMessageMock.mock.calls[0][2]).toContain("排队上限");

    releaseActive();
    await Promise.all(queued);
  });

  it("reserves depth before asynchronous ACK creation so a burst cannot over-admit", async () => {
    // A null card keeps the ACK path asynchronous (one promise turn) while
    // making terminal overflow replies fall back to sendMessage.
    shared.createAICardMock.mockResolvedValue(null);
    let releaseActive: () => void = () => {};
    let resolveActiveStarted: () => void = () => {};
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const activeStarted = new Promise<void>((resolve) => {
      resolveActiveStarted = resolve;
    });
    const active = dispatchInboundViaSessionQueue(
      queueInput(buildMessage("查询A", "msg_burst_active")),
      async () => {
        resolveActiveStarted();
        await activeGate;
      },
    );
    await activeStarted;

    const admittedHandlers = Array.from({ length: MAX_INBOUND_SESSION_QUEUE_DEPTH - 1 }, () =>
      vi.fn(async () => undefined),
    );
    const overflowHandlers = [vi.fn(async () => undefined), vi.fn(async () => undefined)];
    const burst = [...admittedHandlers, ...overflowHandlers].map((handler, index) =>
      dispatchInboundViaSessionQueue(
        queueInput(buildMessage("确认", `msg_burst_${index}`)),
        handler,
      ),
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(shared.sendMessageMock).toHaveBeenCalledTimes(2);
    expect(admittedHandlers.every((handler) => handler.mock.calls.length === 0)).toBe(true);
    expect(overflowHandlers.every((handler) => handler.mock.calls.length === 0)).toBe(true);

    releaseActive();
    await Promise.all([active, ...burst]);
    expect(admittedHandlers.every((handler) => handler.mock.calls.length === 1)).toBe(true);
    expect(overflowHandlers.every((handler) => handler.mock.calls.length === 0)).toBe(true);
  });

    it("does not discard a manual resend with the same text while its first copy is active", async () => {
      shared.createAICardMock.mockResolvedValue(null);
      shared.extractMessageContentMock.mockImplementation((data: any) => ({
        text: data?.text?.content,
        messageType: "text",
      }));
      let releaseFirst: () => void = () => {};
      let resolveFirstStarted: () => void = () => {};
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const firstStarted = new Promise<void>((resolve) => {
        resolveFirstStarted = resolve;
      });
      const first = dispatchInboundViaSessionQueue(
        queueInput(buildMessage("确认", "msg_duplicate_first")),
        async () => {
          resolveFirstStarted();
          await firstGate;
        },
      );
      await firstStarted;

      const duplicateHandler = vi.fn(async () => undefined);
      const second = dispatchInboundViaSessionQueue(
        queueInput(buildMessage("确认", "msg_duplicate_resend")),
        duplicateHandler,
      );
      await Promise.resolve();
      expect(duplicateHandler).not.toHaveBeenCalled();
      releaseFirst();
      await Promise.all([first, second]);
      expect(duplicateHandler).toHaveBeenCalledTimes(1);
    });

    it("bypasses the authorized queue for /stop while the same session is active", async () => {
      shared.extractMessageContentMock.mockImplementation((data: any) => ({
        text: data?.text?.content,
        messageType: "text",
      }));
      shared.isAbortRequestTextMock.mockImplementation((text: string) => text === "/stop");
      let releaseActive: () => void = () => {};
      let resolveActiveStarted: () => void = () => {};
      const activeGate = new Promise<void>((resolve) => {
        releaseActive = resolve;
      });
      const activeStarted = new Promise<void>((resolve) => {
        resolveActiveStarted = resolve;
      });
      let callCount = 0;
      shared.dispatchMock.mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) {
          resolveActiveStarted();
          return activeGate.then(() => ({ queuedFinal: undefined }));
        }
        return Promise.resolve({ queuedFinal: undefined });
      });

      const active = dispatch(buildMessage("长任务", "msg_stop_active"));
      await activeStarted;
      const stop = dispatch(buildMessage("/stop", "msg_stop_bypass"));

      await vi.waitFor(() => expect(shared.dispatchMock).toHaveBeenCalledTimes(2));
      releaseActive();
      await Promise.all([active, stop]);
    });

    it("bypasses the authorized queue for /btw while the same session is active", async () => {
      shared.extractMessageContentMock.mockImplementation((data: any) => ({
        text: data?.text?.content,
        messageType: "text",
      }));
      shared.isBtwRequestTextMock.mockImplementation((text: string) => text === "/btw status");
      let releaseActive: () => void = () => {};
      let resolveActiveStarted: () => void = () => {};
      const activeGate = new Promise<void>((resolve) => {
        releaseActive = resolve;
      });
      const activeStarted = new Promise<void>((resolve) => {
        resolveActiveStarted = resolve;
      });
      let callCount = 0;
      shared.dispatchMock.mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) {
          resolveActiveStarted();
          return activeGate.then(() => ({ queuedFinal: undefined }));
        }
        return Promise.resolve({ queuedFinal: undefined });
      });

      const active = dispatch(buildMessage("长任务", "msg_btw_active"));
      await activeStarted;
      const sideQuestion = dispatch(buildMessage("/btw status", "msg_btw_bypass"));

      await vi.waitFor(() => expect(shared.dispatchMock).toHaveBeenCalledTimes(2));
      releaseActive();
      await Promise.all([active, sideQuestion]);
    });

    it("does not create a queue acknowledgement for an unauthorized group message", async () => {
      shared.extractMessageContentMock.mockImplementation((data: any) => ({
        text: data?.text?.content,
        messageType: "text",
      }));
      const activeGate = new Promise<void>(() => {});
      void chainInboundSessionTask(SESSION_KEY, () => activeGate);
      const blocked = buildMessage("确认", "msg_group_blocked");
      blocked.data.conversationType = "2";
      blocked.data.conversationId = "cid_blocked_group";
      blocked.dingtalkConfig = {
        ...blocked.dingtalkConfig,
        groupPolicy: "allowlist",
        groups: {},
        messageType: "card",
      };

      await handleDingTalkMessage(blocked);

      expect(shared.createAICardMock).not.toHaveBeenCalled();
      expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    });

    it("recalls an unused pre-created queue ACK card after a non-card handler returns", async () => {
      shared.extractMessageContentMock.mockImplementation((data: any) => ({
        text: data?.text?.content,
        messageType: "text",
      }));
      const queuedCard = {
        cardInstanceId: "card_unused_queue_ack",
        outTrackId: "track_unused_queue_ack",
        state: "INPUTING",
        storePath: STORE_PATH,
        lastUpdated: Date.now(),
      };
      shared.createAICardMock.mockResolvedValue(queuedCard);
      shared.isCardInTerminalStateMock.mockReturnValue(false);
      let releaseFirst: () => void = () => {};
      let resolveFirstStarted: () => void = () => {};
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const firstStarted = new Promise<void>((resolve) => {
        resolveFirstStarted = resolve;
      });
      const first = dispatchInboundViaSessionQueue(
        queueInput(buildMessage("查询", "msg_unused_active")),
        async () => {
          resolveFirstStarted();
          await firstGate;
        },
      );
      await firstStarted;
      const queued = dispatchInboundViaSessionQueue(
        queueInput(buildMessage("另一个命令", "msg_unused_queued")),
        async () => undefined,
      );
      await vi.waitFor(() => expect(shared.streamAICardMock).toHaveBeenCalled());

      releaseFirst();
      await Promise.all([first, queued]);
      expect(shared.recallAICardMessageMock).toHaveBeenCalledWith(queuedCard, undefined);
    });

    it("finishes a queued ACK with a retryable failure when its handler throws", async () => {
      shared.extractMessageContentMock.mockImplementation((data: any) => ({
        text: data?.text?.content,
        messageType: "text",
      }));
      const queuedCard = {
        cardInstanceId: "card_failed_queue_ack",
        outTrackId: "track_failed_queue_ack",
        state: "INPUTING",
        storePath: STORE_PATH,
        lastUpdated: Date.now(),
      };
      shared.createAICardMock.mockResolvedValue(queuedCard);
      shared.isCardInTerminalStateMock.mockReturnValue(false);

      let releaseFirst: () => void = () => {};
      let resolveFirstStarted: () => void = () => {};
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const firstStarted = new Promise<void>((resolve) => {
        resolveFirstStarted = resolve;
      });
      const first = dispatchInboundViaSessionQueue(
        queueInput(buildMessage("查询", "msg_failure_active")),
        async () => {
          resolveFirstStarted();
          await firstGate;
        },
      );
      await firstStarted;
      const queued = dispatchInboundViaSessionQueue(
        queueInput(buildMessage("确认", "msg_failure_queued")),
        async () => {
          throw new Error("sessions.json EBUSY");
        },
      ).catch((error: unknown) => error);
      await vi.waitFor(() => expect(shared.streamAICardMock).toHaveBeenCalled());

      releaseFirst();
      await first;
      const error = await queued;

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("sessions.json EBUSY");
      expect(shared.recallAICardMessageMock).not.toHaveBeenCalledWith(queuedCard, undefined);
      expect(shared.streamAICardMock).toHaveBeenCalledWith(
        queuedCard,
        expect.stringContaining("本次处理异常"),
        true,
        undefined,
      );
    });

  it("ask-user reinjections BYPASS the queue (no queue-busy ACK card prepared)", async () => {
    let resolveFirstDispatchStarted: () => void = () => {};
    const firstDispatchStarted = new Promise<void>((resolve) => {
      resolveFirstDispatchStarted = resolve;
    });
    shared.createAICardMock.mockImplementation(async () => ({
      cardInstanceId: `card_${(cardSerial += 1)}`,
      outTrackId: `card_${cardSerial}`,
      state: "INPUTING",
      storePath: STORE_PATH,
      lastStreamedContent: "",
      lastUpdated: Date.now(),
    }));
    shared.isCardInTerminalStateMock.mockReturnValue(false);
    shared.extractMessageContentMock.mockImplementation((data: any) => ({
      text: data?.text?.content,
      messageType: "text",
    }));

    // A (stream) is an active run whose dispatch hangs, keeping the
    // conversation's queue busy.
    let resolveADispatch: () => void = () => {};
    const aDispatchGate = new Promise<void>((resolve) => {
      resolveADispatch = resolve;
    });
    let dispatchCallCount = 0;
    shared.dispatchMock.mockImplementation(() => {
      dispatchCallCount += 1;
      if (dispatchCallCount === 1) {
        resolveFirstDispatchStarted();
        return aDispatchGate.then(() => ({ queuedFinal: undefined }));
      }
      return Promise.resolve({ queuedFinal: undefined });
    });

    const aPromise = dispatch(buildMessage("提问", "msg_a"));
    await firstDispatchStarted;

    // An ask-user answer is delivered by a DIRECT call to handleDingTalkMessage
    // (ask-user-question.ts does this) — it never enters the gateway dispatcher,
    // so the queue is bypassed and NO queue-busy ACK card is prepared for it.
    const answerMsg = buildMessage("答复", "msg_answer");
    answerMsg.inboundOrigin = "ask-user";
    const answerPromise = handleDingTalkMessage(answerMsg);
    // Let the dispatcher run synchronously up to its first real await.
    await Promise.resolve();
    await Promise.resolve();

    const ackStreamCalls = shared.streamAICardMock.mock.calls.filter((call: any[]) =>
      (QUEUE_BUSY_ACK_PHRASES as readonly string[]).includes(call[1]),
    );
    expect(ackStreamCalls.length).toBe(0);

    // Release A so the answer (which still acquires the per-session lock inside
    // the handler) can proceed and the test leaves no pending work behind.
    resolveADispatch();
    await Promise.all([aPromise, answerPromise]);
    expect(shared.dispatchMock).toHaveBeenCalledTimes(2);
  });
});
