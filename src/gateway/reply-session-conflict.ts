// When a new inbound message arrives while the openclaw core still has an
// active (processing / paused) run for the same session key, the core's reply
// resolver rejects the dispatch with:
//   "reply session initialization conflicted for <sessionKey>"
//
// Without handling, this error propagates to the gateway catch block and the
// message is silently dropped — the user sees no reply at all (the
// "钉钉'确认'消息无响应" regression).
//
// This module lets the DingTalk channel treat that conflict as a transient,
// queue-like condition: retry the dispatch a few times with backoff so a run
// that drains within seconds is picked up, instead of failing fast.

const REPLY_SESSION_CONFLICT_PATTERN = /reply session initialization conflicted/i;

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    const msg = (error as Record<string, unknown>).message;
    return typeof msg === "string" ? msg : "";
  }
  return "";
}

export function isReplySessionConflictError(error: unknown): boolean {
  return REPLY_SESSION_CONFLICT_PATTERN.test(readErrorMessage(error));
}

export interface ReplySessionConflictRetryOptions {
  /** How many times to retry after the first conflict (default 3). */
  maxRetries?: number;
  /** Base backoff in ms; actual delay grows linearly per attempt (default 1500). */
  baseDelayMs?: number;
  /** Optional structured logger used for diagnostic warnings. */
  log?: {
    warn?: (message: string) => void;
    info?: (message: string) => void;
  };
  /** Session key included in log lines for correlation. */
  sessionKey?: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Run `fn`, retrying only when it fails with a reply-session initialization
 * conflict. Any other error is re-thrown immediately. After `maxRetries`
 * conflicts the last conflict error is re-thrown so the caller can apply its
 * own fallback (e.g. an immediate "processing" acknowledgement).
 */
export async function withReplySessionConflictRetry<T>(
  fn: () => Promise<T>,
  options: ReplySessionConflictRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1500;
  const sessionLabel = options.sessionKey ?? "?";

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isReplySessionConflictError(error) || attempt >= maxRetries) {
        throw error;
      }
      const delay = baseDelayMs * (attempt + 1);
      options.log?.warn?.(
        `[DingTalk] Reply session initialization conflicted for session=${sessionLabel}; ` +
          `active run still draining. Retry ${attempt + 1}/${maxRetries} after ${delay}ms.`,
      );
      await sleep(delay);
    }
  }
}
