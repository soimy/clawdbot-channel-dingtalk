import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  updateCardVariables: vi.fn(async () => undefined),
  handleDingTalkMessage: vi.fn(async () => undefined),
  axiosPost: vi.fn(),
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
  registerDingTalkAskUserQuestionTool,
} from "../../src/card/ask-user-question";
import { withDingTalkQuestionContext } from "../../src/card/ask-user-question-context";
import { resolveAskUserQuestion } from "../../src/card/ask-user-question-store";
import { resolveNamespacePath } from "../../src/persistence-store";

type AskUserTool = {
  execute: (toolCallId: string, params: unknown) => Promise<any>;
};

type AskUserToolFactory = (context: { sessionKey?: string }) => AskUserTool;

describe("Ask User delivery activation gate", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-ask-user-delivery-race-"));
    storePath = path.join(tempDir, "sessions.json");
    shared.updateCardVariables.mockClear();
    shared.handleDingTalkMessage.mockClear();
    shared.axiosPost.mockReset();
  });

  afterEach(() => {
    clearPendingQuestionsForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not revive a reserved question invalidated while card delivery is in flight", async () => {
    let toolFactory: AskUserToolFactory | undefined;
    registerDingTalkAskUserQuestionTool({
      registerTool: (registered: unknown) => {
        toolFactory = registered as AskUserToolFactory;
      },
      logger: {},
    } as any);

    let finishDelivery:
      | ((value: { status: number; data: { result: { deliverResults: Array<{ success: true }> } } }) => void)
      | undefined;
    shared.axiosPost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDelivery = resolve;
        }),
    );
    const onQuestionCardSent = vi.fn(async () => true);

    const execution = withDingTalkQuestionContext(
      {
        cfg: {} as any,
        accountId: "main",
        storePath,
        questionScopeKey: "main:s1:user_1",
        data: {
          msgId: "msg_delivery_race",
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
        onQuestionCardSent,
      },
      async () =>
        toolFactory!({}).execute("tool_delivery_race", {
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

    await vi.waitFor(() => expect(shared.axiosPost).toHaveBeenCalledTimes(1));
    const requestBody = shared.axiosPost.mock.calls[0]?.[1] as { outTrackId: string };
    const reserved = resolveAskUserQuestion(
      { storePath, accountId: "main" },
      { outTrackId: requestBody.outTrackId },
    );
    expect(reserved).toMatchObject({ state: "reserved" });

    invalidateAskUserQuestionsForScope({
      storePath,
      accountId: "main",
      questionScopeKey: "main:s1:user_1",
      reason: "superseded_by_message",
    });
    finishDelivery?.({
      status: 200,
      data: { result: { deliverResults: [{ success: true }] } },
    });

    const result = await execution;
    expect(result.details).toMatchObject({
      status: "failed",
      questionId: reserved?.questionId,
      outTrackId: requestBody.outTrackId,
    });
    expect(onQuestionCardSent).not.toHaveBeenCalled();
    expect(
      resolveAskUserQuestion(
        { storePath, accountId: "main" },
        { questionId: reserved?.questionId },
      ),
    ).toMatchObject({ state: "terminal", terminalReason: "superseded_by_message" });

    await expect(
      handleDingTalkAskUserCardCallback({
        payload: {
          outTrackId: requestBody.outTrackId,
          content: JSON.stringify({
            cardPrivateData: {
              actionIds: [reserved?.questionId],
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
    expect(shared.handleDingTalkMessage).not.toHaveBeenCalled();
  });

  it("fails closed when the reserved lifecycle record disappears during delivery", async () => {
    let toolFactory: AskUserToolFactory | undefined;
    registerDingTalkAskUserQuestionTool({
      registerTool: (registered: unknown) => {
        toolFactory = registered as AskUserToolFactory;
      },
      logger: {},
    } as any);

    let finishDelivery:
      | ((value: { status: number; data: { result: { deliverResults: Array<{ success: true }> } } }) => void)
      | undefined;
    shared.axiosPost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDelivery = resolve;
        }),
    );
    const onQuestionCardSent = vi.fn(async () => true);
    const execution = withDingTalkQuestionContext(
      {
        cfg: {} as any,
        accountId: "main",
        storePath,
        questionScopeKey: "main:s1:user_1",
        data: {
          msgId: "msg_missing_record",
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
        onQuestionCardSent,
      },
      async () =>
        toolFactory!({}).execute("tool_missing_record", {
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

    await vi.waitFor(() => expect(shared.axiosPost).toHaveBeenCalledTimes(1));
    const requestBody = shared.axiosPost.mock.calls[0]?.[1] as { outTrackId: string };
    fs.rmSync(
      resolveNamespacePath("cards.ask-user.lifecycle", {
        storePath,
        scope: { accountId: "main" },
      }),
      { force: true },
    );
    finishDelivery?.({
      status: 200,
      data: { result: { deliverResults: [{ success: true }] } },
    });

    const result = await execution;
    expect(result.details).toMatchObject({
      status: "failed",
      outTrackId: requestBody.outTrackId,
      error: "问题卡片在发送期间已失效，请重新发起。",
    });
    expect(onQuestionCardSent).not.toHaveBeenCalled();
  });
});
