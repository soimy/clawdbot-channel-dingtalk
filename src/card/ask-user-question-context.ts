import { AsyncLocalStorage } from "node:async_hooks";
import type {
  DingTalkConfig,
  DingTalkInboundMessage,
  HandleDingTalkMessageParams,
  Logger,
  ResolvedDingTalkRoute,
  SubAgentOptions,
} from "../types";

export type DingTalkQuestionContext = {
  cfg: HandleDingTalkMessageParams["cfg"];
  accountId: string;
  data: DingTalkInboundMessage;
  sessionWebhook: string;
  log?: Logger;
  dingtalkConfig: DingTalkConfig;
  storePath?: string;
  questionScopeKey?: string;
  resolvedRoute?: ResolvedDingTalkRoute;
  continuationSubAgentOptions?: Omit<SubAgentOptions, "commandText">;
  onQuestionCardSent?: (event: {
    questionId: string;
    outTrackId: string;
  }) => boolean | void | Promise<boolean | void>;
};

const questionContextStorage = new AsyncLocalStorage<DingTalkQuestionContext>();
const questionContextsBySessionKey = new Map<string, DingTalkQuestionContext>();
const MAX_QUESTION_SESSION_CONTEXTS = 1_000;

export function withDingTalkQuestionContext<T>(
  context: DingTalkQuestionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return questionContextStorage.run(context, fn);
}

export function getDingTalkQuestionContext(): DingTalkQuestionContext | undefined {
  return questionContextStorage.getStore();
}

export function bindDingTalkQuestionContextToSession(
  sessionKey: string,
  context: DingTalkQuestionContext,
): void {
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) {
    return;
  }

  // Refresh insertion order so the bounded map keeps the most recently used sessions.
  questionContextsBySessionKey.delete(normalizedSessionKey);
  questionContextsBySessionKey.set(normalizedSessionKey, context);
  while (questionContextsBySessionKey.size > MAX_QUESTION_SESSION_CONTEXTS) {
    const oldestSessionKey = questionContextsBySessionKey.keys().next().value;
    if (typeof oldestSessionKey !== "string") {
      break;
    }
    questionContextsBySessionKey.delete(oldestSessionKey);
  }
}

export function getDingTalkQuestionContextForSession(
  sessionKey?: string,
): DingTalkQuestionContext | undefined {
  const normalizedSessionKey = sessionKey?.trim();
  if (!normalizedSessionKey) {
    return undefined;
  }
  return questionContextsBySessionKey.get(normalizedSessionKey);
}

export function clearDingTalkQuestionSessionContextsForTest(): void {
  questionContextsBySessionKey.clear();
}
