import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  updateCardVariables: vi.fn(async () => undefined),
  handleDingTalkMessage: vi.fn(async () => undefined),
  axiosPost: vi.fn(async () => ({
    status: 200,
    data: { result: { deliverResults: [{ success: true }] } },
  })),
}));

vi.mock("../../src/auth", () => ({
  getAccessToken: vi.fn(async () => "access-token"),
}));

vi.mock("../../src/card-callback-service", () => ({
  updateCardVariables: shared.updateCardVariables,
}));

vi.mock("../../src/inbound-handler", () => ({
  handleDingTalkMessage: shared.handleDingTalkMessage,
}));

vi.mock("../../src/http-client", () => ({
  default: { post: shared.axiosPost },
}));

import {
  clearPendingQuestionsForTest,
  handleDingTalkAskUserCardCallback,
  invalidateAskUserQuestionsForScope,
  recoverAskUserQuestionsForAccount,
  registerPendingQuestionForTest,
  registerDingTalkAskUserQuestionTool,
  syncInvalidatedAskUserQuestionCards,
} from "../../src/card/ask-user-question";
import { withDingTalkQuestionContext } from "../../src/card/ask-user-question-context";
import {
  activateAskUserQuestion,
  claimAskUserQuestion,
  reserveAskUserQuestion,
  resolveAskUserQuestion,
} from "../../src/card/ask-user-question-store";

type AskUserTool = {
  execute: (toolCallId: string, params: unknown) => Promise<any>;
};

type AskUserToolFactory = (context: { sessionKey?: string }) => AskUserTool;

describe("Ask User lifecycle integration", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-ask-user-lifecycle-"));
    storePath = path.join(tempDir, "sessions.json");
    shared.updateCardVariables.mockClear();
    shared.handleDingTalkMessage.mockReset().mockResolvedValue(undefined);
    shared.axiosPost.mockClear();
  });

  afterEach(() => {
    clearPendingQuestionsForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function seedQuestion(params: { questionId: string; outTrackId: string; scope?: string }): void {
    reserveAskUserQuestion(
      { storePath, accountId: "main" },
      {
        questionId: params.questionId,
        outTrackId: params.outTrackId,
        questionScopeKey: params.scope ?? "main:s1:user_1",
        title: "需要确认",
      },
    );
    activateAskUserQuestion({ storePath, accountId: "main" }, params.questionId);
  }

  it("invalidates a pending card with the exact newer-message explanation", async () => {
    seedQuestion({ questionId: "q_old", outTrackId: "ask_old" });

    const invalidated = invalidateAskUserQuestionsForScope({
      storePath,
      accountId: "main",
      questionScopeKey: "main:s1:user_1",
      reason: "superseded_by_message",
    });
    await syncInvalidatedAskUserQuestionCards({
      records: invalidated,
      config: {} as any,
    });

    expect(invalidated.map((record) => record.questionId)).toEqual(["q_old"]);
    expect(
      resolveAskUserQuestion({ storePath, accountId: "main" }, { questionId: "q_old" }),
    ).toMatchObject({ state: "terminal", terminalReason: "superseded_by_message" });
    expect(shared.updateCardVariables).toHaveBeenCalledWith(
      "ask_old",
      expect.objectContaining({
        card_status: "expired",
        question_desc: "你在问题卡片发出后发送了新消息，此卡已失效。请重新发起需要填写的问题。",
        form_btn_text: "已失效",
      }),
      "access-token",
      {},
    );
  });

  it("fails closed on restart without injecting a synthetic message", async () => {
    seedQuestion({ questionId: "q_pending", outTrackId: "ask_pending" });
    seedQuestion({
      questionId: "q_dispatching",
      outTrackId: "ask_dispatching",
      scope: "main:s1:user_2",
    });
    claimAskUserQuestion({ storePath, accountId: "main" }, { questionId: "q_dispatching" });

    await expect(
      recoverAskUserQuestionsForAccount({
        storePath,
        accountId: "main",
        config: {} as any,
      }),
    ).resolves.toBe(2);

    expect(shared.updateCardVariables).toHaveBeenCalledWith(
      "ask_pending",
      expect.objectContaining({
        question_desc: "服务已重启，原问题上下文已失效，请重新发起。",
      }),
      "access-token",
      {},
    );
    expect(shared.updateCardVariables).toHaveBeenCalledWith(
      "ask_dispatching",
      expect.objectContaining({
        question_desc: "服务在处理回答期间重启，本次处理结果可能未完成，请发送新消息继续。",
      }),
      "access-token",
      {},
    );
    expect(shared.handleDingTalkMessage).not.toHaveBeenCalled();
  });

  it("records dispatch_failed and updates the card when synthetic inbound rejects", async () => {
    seedQuestion({ questionId: "q_submit", outTrackId: "ask_submit" });
    registerPendingQuestionForTest({
      cfg: {} as any,
      accountId: "main",
      storePath,
      questionScopeKey: "main:s1:user_1",
      data: {
        msgId: "msg_1",
        msgtype: "text",
        createAt: Date.now(),
        text: { content: "ask" },
        conversationType: "1",
        conversationId: "cid_1",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://example.com/webhook",
      },
      sessionWebhook: "https://example.com/webhook",
      dingtalkConfig: {} as any,
      questionId: "q_submit",
      outTrackId: "ask_submit",
      title: "需要确认",
      questions: [
        {
          fieldName: "answer_0",
          title: "确认",
          options: [{ value: "yes", text: "确认" }],
          multiSelect: false,
        },
      ],
    });
    shared.handleDingTalkMessage.mockRejectedValueOnce(new Error("dispatch unavailable"));

    await expect(
      handleDingTalkAskUserCardCallback({
        payload: {
          outTrackId: "ask_submit",
          content: JSON.stringify({
            cardPrivateData: {
              actionIds: ["q_submit"],
              params: { form: { answer_0: "yes" } },
            },
          }),
        },
        cfg: {} as any,
        accountId: "main",
        storePath,
        config: {} as any,
        clickerUserId: "user_1",
      }),
    ).resolves.toEqual({ handled: true });

    await vi.waitFor(() => {
      expect(
        resolveAskUserQuestion({ storePath, accountId: "main" }, { questionId: "q_submit" }),
      ).toMatchObject({ state: "terminal", terminalReason: "dispatch_failed" });
    });
    expect(shared.handleDingTalkMessage).toHaveBeenCalledWith(
      expect.objectContaining({ inboundOrigin: "ask-user" }),
    );
    expect(shared.updateCardVariables).toHaveBeenLastCalledWith(
      "ask_submit",
      expect.objectContaining({
        question_desc: "回答已收到，但未能继续会话，请发送一条普通消息继续。",
      }),
      "access-token",
      {},
    );
  });

  it("reinjects a sub-agent answer through the captured route without replaying a command", async () => {
    seedQuestion({ questionId: "q_route", outTrackId: "ask_route" });
    registerPendingQuestionForTest({
      cfg: {} as any,
      accountId: "main",
      storePath,
      questionScopeKey: "main:agent:expert:dingtalk:direct:user_1:user_1",
      resolvedRoute: {
        agentId: "expert",
        sessionKey: "agent:expert:dingtalk:direct:user_1",
        mainSessionKey: "",
      },
      continuationSubAgentOptions: {
        agentId: "expert",
        responsePrefix: "> 🤖 **Expert**:\n\n",
        matchedName: "Expert",
      },
      data: {
        msgId: "msg_route",
        msgtype: "text",
        createAt: Date.now(),
        text: { content: "ask expert" },
        conversationType: "1",
        conversationId: "cid_1",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://example.com/webhook",
      },
      sessionWebhook: "https://example.com/webhook",
      dingtalkConfig: {} as any,
      questionId: "q_route",
      outTrackId: "ask_route",
      title: "需要确认",
      questions: [
        {
          fieldName: "answer_0",
          title: "确认",
          options: [{ value: "yes", text: "确认" }],
          multiSelect: false,
        },
      ],
    });

    await expect(
      handleDingTalkAskUserCardCallback({
        payload: {
          outTrackId: "ask_route",
          content: JSON.stringify({
            cardPrivateData: {
              actionIds: ["q_route"],
              params: { form: { answer_0: "yes" } },
            },
          }),
        },
        cfg: {} as any,
        accountId: "main",
        storePath,
        config: {} as any,
        clickerUserId: "user_1",
      }),
    ).resolves.toEqual({ handled: true });

    await vi.waitFor(() => expect(shared.handleDingTalkMessage).toHaveBeenCalledTimes(1));
    expect(shared.handleDingTalkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        inboundOrigin: "ask-user",
        routeOverride: {
          agentId: "expert",
          sessionKey: "agent:expert:dingtalk:direct:user_1",
          mainSessionKey: "",
        },
        subAgentOptions: {
          agentId: "expert",
          responsePrefix: "> 🤖 **Expert**:\n\n",
          matchedName: "Expert",
        },
      }),
    );
    expect(shared.handleDingTalkMessage.mock.calls[0]?.[0]?.subAgentOptions).not.toHaveProperty(
      "commandText",
    );
  });

  it("keeps a duplicate callback terminally handled while the first answer is dispatching", async () => {
    seedQuestion({ questionId: "q_duplicate", outTrackId: "ask_duplicate" });
    registerPendingQuestionForTest({
      cfg: {} as any,
      accountId: "main",
      storePath,
      questionScopeKey: "main:s1:user_1",
      data: {
        msgId: "msg_duplicate",
        msgtype: "text",
        createAt: Date.now(),
        text: { content: "ask" },
        conversationType: "1",
        conversationId: "cid_1",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://example.com/webhook",
      },
      sessionWebhook: "https://example.com/webhook",
      dingtalkConfig: {} as any,
      questionId: "q_duplicate",
      outTrackId: "ask_duplicate",
      title: "需要确认",
      questions: [
        {
          fieldName: "answer_0",
          title: "确认",
          options: [{ value: "yes", text: "确认" }],
          multiSelect: false,
        },
      ],
    });
    shared.handleDingTalkMessage.mockImplementationOnce(() => new Promise<void>(() => undefined));
    const callback = {
      payload: {
        outTrackId: "ask_duplicate",
        content: JSON.stringify({
          cardPrivateData: {
            actionIds: ["q_duplicate"],
            params: { form: { answer_0: "yes" } },
          },
        }),
      },
      cfg: {} as any,
      accountId: "main",
      storePath,
      config: {} as any,
      clickerUserId: "user_1",
    };

    await expect(handleDingTalkAskUserCardCallback(callback)).resolves.toEqual({ handled: true });
    await expect(handleDingTalkAskUserCardCallback(callback)).resolves.toEqual({ handled: true });

    const lifecycle = resolveAskUserQuestion(
      { storePath, accountId: "main" },
      { questionId: "q_duplicate" },
    );
    expect(lifecycle).toMatchObject({ state: "dispatching" });
    expect(lifecycle).not.toHaveProperty("terminalReason");
    expect(shared.handleDingTalkMessage).toHaveBeenCalledTimes(1);
  });

  it("handles a late callback from a persisted tombstone without dispatching", async () => {
    seedQuestion({ questionId: "q_late", outTrackId: "ask_late" });
    invalidateAskUserQuestionsForScope({
      storePath,
      accountId: "main",
      questionScopeKey: "main:s1:user_1",
      reason: "superseded_by_message",
    });
    shared.handleDingTalkMessage.mockClear();

    await expect(
      handleDingTalkAskUserCardCallback({
        payload: {
          outTrackId: "ask_late",
          content: JSON.stringify({
            cardPrivateData: {
              actionIds: ["q_late"],
              params: { form: { answer_0: "late" } },
            },
          }),
        },
        cfg: {} as any,
        accountId: "main",
        storePath,
        config: {} as any,
      }),
    ).resolves.toEqual({ handled: true });
    expect(shared.handleDingTalkMessage).not.toHaveBeenCalled();
  });

  it("invalidates the delivered card and reports failure when targeted pause does not succeed", async () => {
    let toolFactory: AskUserToolFactory | undefined;
    registerDingTalkAskUserQuestionTool({
      registerTool: (registered: unknown) => {
        toolFactory = registered as AskUserToolFactory;
      },
      logger: {},
    } as any);

    const result = await withDingTalkQuestionContext(
      {
        cfg: {} as any,
        accountId: "main",
        storePath,
        questionScopeKey: "main:s1:user_1",
        data: {
          msgId: "msg_pause",
          msgtype: "text",
          createAt: Date.now(),
          text: { content: "ask" },
          conversationType: "1",
          conversationId: "cid_1",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://example.com/webhook",
        },
        sessionWebhook: "https://example.com/webhook",
        dingtalkConfig: { clientId: "client", clientSecret: "secret" } as any,
        onQuestionCardSent: async () => false,
      },
      async () =>
        toolFactory!({}).execute("tool_1", {
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
        }),
    );

    expect(result.details).toMatchObject({
      status: "failed",
      error: "当前任务未能暂停，此卡已失效，请重新发起。",
    });
    const persisted = resolveAskUserQuestion(
      { storePath, accountId: "main" },
      { questionId: result.details.questionId },
    );
    expect(persisted).toMatchObject({ state: "terminal", terminalReason: "pause_failed" });
    expect(shared.updateCardVariables).toHaveBeenCalledWith(
      result.details.outTrackId,
      expect.objectContaining({
        question_desc: "当前任务未能暂停，此卡已失效，请重新发起。",
      }),
      "access-token",
      expect.anything(),
    );
  });
});
