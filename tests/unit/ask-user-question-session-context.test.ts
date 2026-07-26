import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  axiosPost: vi.fn(async () => ({
    status: 200,
    data: { result: { deliverResults: [{ success: true }] } },
  })),
}));

vi.mock("../../src/auth", () => ({
  getAccessToken: vi.fn(async () => "access-token"),
}));

vi.mock("../../src/card-callback-service", () => ({
  updateCardVariables: vi.fn(async () => undefined),
}));

vi.mock("../../src/inbound-handler", () => ({
  handleDingTalkMessage: vi.fn(async () => undefined),
}));

vi.mock("../../src/http-client", () => ({
  default: { post: shared.axiosPost },
}));

import {
  clearPendingQuestionsForTest,
  registerDingTalkAskUserQuestionTool,
} from "../../src/card/ask-user-question";
import {
  bindDingTalkQuestionContextToSession,
  clearDingTalkQuestionSessionContextsForTest,
  type DingTalkQuestionContext,
  withDingTalkQuestionContext,
} from "../../src/card/ask-user-question-context";

type AskUserTool = {
  execute: (toolCallId: string, params: unknown) => Promise<any>;
};

type AskUserToolFactory = (context: { sessionKey?: string }) => AskUserTool;

function questionContext(params: {
  conversationType: "1" | "2";
  conversationId: string;
  senderId: string;
}): DingTalkQuestionContext {
  return {
    cfg: {} as any,
    accountId: "main",
    data: {
      msgId: `msg_${params.conversationId}`,
      msgtype: "text",
      createAt: Date.now(),
      text: { content: "ask" },
      conversationType: params.conversationType,
      conversationId: params.conversationId,
      senderId: params.senderId,
      chatbotUserId: "bot_1",
      sessionWebhook: "https://example.com/webhook",
    },
    sessionWebhook: "https://example.com/webhook",
    dingtalkConfig: {
      clientId: "client",
      clientSecret: "secret",
      robotCode: "robot",
    } as any,
    onQuestionCardSent: async () => true,
  };
}

function registerToolFactory(): {
  factory: AskUserToolFactory;
  options: unknown;
} {
  let factory: AskUserToolFactory | undefined;
  let options: unknown;
  registerDingTalkAskUserQuestionTool({
    registerTool: (registered: unknown, registeredOptions: unknown) => {
      factory = registered as AskUserToolFactory;
      options = registeredOptions;
    },
    logger: {},
  } as any);
  return { factory: factory!, options };
}

const QUESTION_PARAMS = {
  questions: [
    {
      question: "是否继续？",
      header: "确认",
      options: [
        { label: "继续", value: "yes" },
        { label: "取消", value: "no" },
      ],
    },
  ],
};

describe("Ask User session-bound tool context", () => {
  beforeEach(() => {
    shared.axiosPost.mockClear();
    clearDingTalkQuestionSessionContextsForTest();
  });

  afterEach(() => {
    clearPendingQuestionsForTest();
    clearDingTalkQuestionSessionContextsForTest();
  });

  it("delivers to the current group session even when ambient async context is a direct chat", async () => {
    const directContext = questionContext({
      conversationType: "1",
      conversationId: "direct_conversation",
      senderId: "direct_user",
    });
    const groupContext = questionContext({
      conversationType: "2",
      conversationId: "group_conversation",
      senderId: "group_user",
    });
    bindDingTalkQuestionContextToSession("agent:main:dingtalk:direct:direct_user", directContext);
    bindDingTalkQuestionContextToSession(
      "agent:main:dingtalk:group:group_conversation",
      groupContext,
    );

    const registered = registerToolFactory();
    const groupTool = registered.factory({
      sessionKey: "agent:main:dingtalk:group:group_conversation",
    });

    await withDingTalkQuestionContext(directContext, () =>
      groupTool.execute("tool_group", QUESTION_PARAMS),
    );

    expect(registered.options).toEqual({ name: "dingtalk_ask_user_question" });
    expect(shared.axiosPost).toHaveBeenCalledTimes(1);
    expect(shared.axiosPost.mock.calls[0]?.[1]).toMatchObject({
      openSpaceId: "dtv1.card//IM_GROUP.group_conversation",
      imGroupOpenDeliverModel: {
        robotCode: "client",
      },
    });
  });

  it("fails closed when the runtime session has no bound DingTalk context", async () => {
    const staleDirectContext = questionContext({
      conversationType: "1",
      conversationId: "direct_conversation",
      senderId: "direct_user",
    });
    bindDingTalkQuestionContextToSession(
      "agent:main:dingtalk:direct:direct_user",
      staleDirectContext,
    );

    const { factory } = registerToolFactory();
    const unboundTool = factory({ sessionKey: "agent:main:cli:unbound" });
    const result = await withDingTalkQuestionContext(staleDirectContext, () =>
      unboundTool.execute("tool_unbound", QUESTION_PARAMS),
    );

    expect(result.details).toEqual({
      status: "failed",
      error: "dingtalk_ask_user_question can only be used in a DingTalk message context",
    });
    expect(shared.axiosPost).not.toHaveBeenCalled();
  });
});
