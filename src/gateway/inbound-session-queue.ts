// Per-conversation promise-chain serializer for inbound DingTalk messages.
//
// Why this exists: the openclaw core rejects a dispatch whose target session
// already has an active (processing / paused) run with
//   "reply session initialization conflicted for <sessionKey>".
// Without serialization, a message that arrives while another is still being
// processed races into that conflict and is dropped silently at the gateway
// catch block (the "钉钉'确认'消息无响应" regression — the bot shows nothing
// for tens of minutes).
//
// How it works: every inbound message for a conversation is chained onto the
// previous task for that conversation (`sessionQueues`), so a message that
// arrives while another is still running is QUEUED and auto-runs once the
// active run finishes — zero re-send required. While queued, a pre-created AI
// Card shows an immediate "已排队" acknowledgement (see
// `tryPrepareQueueBusyAckCard` in inbound-handler.ts) which the real reply
// later updates in place.
//
// The chain tail stored in the map is rejection-safe: a failed task never
// blocks the next queued message. `chainInboundSessionTask` returns the
// caller-visible promise (which CAN reject) so the gateway's per-message dedup
// (markMessageProcessed runs only after the awaited handler settles) stays
// correct — we never mark a still-queued message as processed.
//
// Ported from the session-queue orchestrator in
// DingTalk-Real-AI/dingtalk-openclaw-connector, adapted to soimy's blocking
// gateway contract.

const SESSION_QUEUE_TTL_MS = 5 * 60 * 1000;
const SESSION_QUEUE_CLEANUP_INTERVAL_MS = 60 * 1000;
// Bound one conversation independently so one hung core run cannot retain an
// unbounded number of user messages in memory. The active task counts toward
// this limit, so at most seven messages may wait behind a running task.
export const MAX_INBOUND_SESSION_QUEUE_DEPTH = 8;
export const MAX_INBOUND_SESSION_QUEUE_WAIT_MS = 15 * 60 * 1000;

const sessionQueues = new Map<string, Promise<void>>();
const sessionLastActivity = new Map<string, number>();
const sessionQueueDepths = new Map<string, number>();
let cleanupTimer: NodeJS.Timeout | null = null;

export class InboundSessionQueueWaitTimeoutError extends Error {
  constructor(queueKey: string) {
    super(`Inbound session queue wait timed out for ${queueKey}`);
    this.name = "InboundSessionQueueWaitTimeoutError";
  }
}

function ensureCleanupTimer(): void {
  if (cleanupTimer) {
    return;
  }
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, lastSeen] of sessionLastActivity) {
      if (now - lastSeen > SESSION_QUEUE_TTL_MS && !sessionQueues.has(key)) {
        sessionLastActivity.delete(key);
      }
    }
  }, SESSION_QUEUE_CLEANUP_INTERVAL_MS);
  if (typeof cleanupTimer?.unref === "function") {
    // Do not keep the Node event loop alive solely for queue bookkeeping.
    cleanupTimer.unref();
  }
}

/**
 * Build the serialization key for an inbound message. We group by
 * (accountId, conversationId): a 1:1 DM maps to one conversationId per user,
 * and a group maps to its conversationId, which is exactly the granularity at
 * which reply-session conflicts occur. Returns null when the key inputs are
 * missing (caller falls back to a direct, un-queued dispatch).
 */
export function deriveInboundQueueKey(parts: {
  accountId: string;
  conversationId?: string;
}): string | null {
  const accountId = (parts.accountId || "").trim();
  const conversationId = (parts.conversationId || "").trim();
  if (!accountId || !conversationId) {
    return null;
  }
  return `${accountId}:${conversationId}`;
}

export function isInboundSessionQueueBusy(queueKey: string): boolean {
  return sessionQueues.has(queueKey);
}

/** Number of active + queued tasks for one conversation. */
export function getInboundSessionQueueDepth(queueKey: string): number {
  return sessionQueueDepths.get(queueKey) ?? 0;
}

export interface InboundSessionTaskOptions {
  /** Maximum time this task may wait before it starts. Does not abort a running task. */
  maxQueueWaitMs?: number;
}

/**
 * Chain `task` onto the previous task for `queueKey`. Returns a promise that
 * settles with `task`'s own outcome (so the caller observes the real result /
 * error), while the stored chain tail is rejection-safe so one failed message
 * never blocks the next queued one.
 */
export function chainInboundSessionTask<T>(
  queueKey: string,
  task: () => Promise<T>,
  options: InboundSessionTaskOptions = {},
): Promise<T> {
  const hadPriorTask = sessionQueues.has(queueKey);
  const previousTail = sessionQueues.get(queueKey) ?? Promise.resolve();
  sessionLastActivity.set(queueKey, Date.now());
  sessionQueueDepths.set(queueKey, getInboundSessionQueueDepth(queueKey) + 1);
  ensureCleanupTimer();

  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  let resolveWaitingCaller: ((value: T) => void) | undefined;
  let rejectWaitingCaller: ((error: Error) => void) | undefined;
  const maxQueueWaitMs = Math.max(0, options.maxQueueWaitMs ?? 0);
  const caller =
    maxQueueWaitMs > 0 && hadPriorTask
      ? new Promise<T>((resolve, reject) => {
          resolveWaitingCaller = resolve;
          rejectWaitingCaller = reject;
          timeout = setTimeout(() => {
            timedOut = true;
            reject(new InboundSessionQueueWaitTimeoutError(queueKey));
          }, maxQueueWaitMs);
          if (typeof timeout.unref === "function") {
            timeout.unref();
          }
        })
      : undefined;

  // A queue timeout can fire while the gateway is still between awaits. Mark
  // this caller-visible rejection as observed immediately so Node/Vitest does
  // not report a transient unhandled rejection; returning `caller` below
  // preserves the same rejection for the gateway to handle normally.
  if (caller) {
    void caller.catch(() => undefined);
  }

  const current = previousTail.then(() => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    if (timedOut) {
      throw new InboundSessionQueueWaitTimeoutError(queueKey);
    }
    return task();
  });
  const tail: Promise<void> = current.then(
    () => undefined,
    () => {
      // Swallow so the next link in the chain still runs even if this task
      // rejected.
    },
  );
  sessionQueues.set(queueKey, tail);

  // Early cleanup, attached to `current` (not `tail`) so it runs in the SAME
  // microtask batch as `current`'s settlement, BEFORE the caller's `await` of
  // `current` resumes. This avoids a brief window where a queue that just
  // settled (e.g. the prior task threw) is still reported busy to the very next
  // inbound message — which would wrongly trigger a queue-busy ACK card.
  //
  // Uses `.then(onSettled, onSettled)` rather than `.finally(...)`: `.finally`
  // would propagate `current`'s rejection to a new promise we never await,
  // surfacing as an unhandled rejection. `.then(fn, fn)` returns a promise that
  // resolves once cleanup finishes, so no rejection escapes.
  const cleanup = (): void => {
    const nextDepth = Math.max(0, getInboundSessionQueueDepth(queueKey) - 1);
    if (nextDepth) {
      sessionQueueDepths.set(queueKey, nextDepth);
    } else {
      sessionQueueDepths.delete(queueKey);
    }
    if (sessionQueues.get(queueKey) === tail) {
      sessionQueues.delete(queueKey);
      sessionLastActivity.delete(queueKey);
    }
  };
  void current.then(cleanup, cleanup);
  if (!caller) {
    return current;
  }
  void current.then(
    (value) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      // The timeout may already have rejected this promise; subsequent resolve
      // is intentionally ignored by Promise semantics.
      resolveWaitingCaller?.(value);
    },
    (error: Error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      rejectWaitingCaller?.(error);
    },
  );
  return caller;
}

/**
 * Phrases shown on the pre-created AI Card when a message is queued behind an
 * active run. Ported from DingTalk-Real-AI/dingtalk-openclaw-connector
 * `QUEUE_BUSY_ACK_PHRASES`.
 */
export const QUEUE_BUSY_ACK_PHRASES = [
  "上一条还没结束，这条我已经记下，稍后按顺序继续处理。",
  "当前还在忙，你的新消息已经排队，上一条完成后我马上继续。",
  "我这边还在处理上一条，这条已加入队列，完成后继续处理。",
] as const;

/**
 * Pick a queue-busy acknowledgement phrase. Pass `seed` for deterministic
 * selection in tests.
 */
export function pickQueueBusyAckPhrase(seed?: number): string {
  const list = QUEUE_BUSY_ACK_PHRASES;
  const index = seed === undefined ? Math.floor(Math.random() * list.length) : seed % list.length;
  return list[index];
}

/** @internal Visible for tests. */
export function inboundSessionQueueBusyKeysForTest(): string[] {
  return [...sessionQueues.keys()];
}

/** @internal Reset all queue state. Tests must call this in afterEach. */
export function resetInboundSessionQueueForTest(): void {
  sessionQueues.clear();
  sessionLastActivity.clear();
  sessionQueueDepths.clear();
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
