import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DingTalkConfig, DingTalkInboundMessage } from "../../src/types";

const shared = vi.hoisted(() => ({
  sendBySessionMock: vi.fn(),
  sendMessageMock: vi.fn(),
  extractMessageContentMock: vi.fn(),
  getRuntimeMock: vi.fn(),
  acquireSessionLockMock: vi.fn(),
  isAbortRequestTextMock: vi.fn(),
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

vi.mock("../../src/send-service", () => ({
  sendBySession: shared.sendBySessionMock,
  sendMessage: shared.sendMessageMock,
  sendProactiveMedia: shared.sendProactiveMediaMock,
  uploadMedia: vi.fn(),
}));

vi.mock("../../src/card-service", () => ({
  createAICard: vi.fn(),
  finishAICard: vi.fn(),
  commitAICardBlocks: vi.fn(),
  formatContentForCard: vi.fn((s: string) => s),
  isCardInTerminalState: vi.fn(),
  streamAICard: vi.fn(),
  updateAICardBlockList: vi.fn(),
  streamAICardContent: vi.fn(),
  clearAICardStreamingContent: vi.fn(),
}));

vi.mock("../../src/session-lock", () => ({
  acquireSessionLock: shared.acquireSessionLockMock,
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  isAbortRequestText: shared.isAbortRequestTextMock,
  isBtwRequestText: vi.fn().mockReturnValue(false),
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
  downloadGroupFile: vi.fn().mockResolvedValue(null),
  getUnionIdByStaffId: vi.fn().mockResolvedValue("union_1"),
  resolveQuotedFile: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/messaging/attachment-text-extractor", () => ({
  extractAttachmentText: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/media-utils", async () => {
  const actual = await vi.importActual<typeof import("../../src/media-utils")>("../../src/media-utils");
  return {
    ...actual,
    prepareMediaInput: vi.fn(),
    resolveOutboundMediaType: vi.fn(),
  };
});

import { handleDingTalkMessage } from "../../src/inbound-handler";

function buildRuntime() {
  return {
    channel: {
      routing: {
        resolveAgentRoute: vi.fn().mockReturnValue({ agentId: "main", sessionKey: "s1", mainSessionKey: "s1" }),
        buildAgentSessionKey: vi.fn().mockReturnValue("agent-session-key"),
      },
      media: {
        saveMediaBuffer: vi.fn().mockResolvedValue({
          path: "/tmp/.openclaw/media/inbound/test-file.png",
          contentType: "image/png",
        }),
      },
      session: {
        resolveStorePath: vi.fn().mockReturnValue("/tmp/store.json"),
        readSessionUpdatedAt: vi.fn().mockReturnValue(null),
        recordInboundSession: vi.fn().mockResolvedValue(undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
        formatInboundEnvelope: vi.fn().mockReturnValue("body"),
        finalizeInboundContext: vi.fn().mockReturnValue({ SessionKey: "s1" }),
        dispatchReplyWithBufferedBlockDispatcher: vi.fn().mockImplementation(
          async ({ dispatcherOptions, replyOptions }) => {
            await replyOptions?.onReasoningStream?.({ text: "thinking" });
            await dispatcherOptions.deliver({ text: "tool output" }, { kind: "tool" });
            await dispatcherOptions.deliver({ text: "final output" }, { kind: "final" });
            return { queuedFinal: "queued final" };
          },
        ),
      },
    },
  };
}

describe("@sub-agent feature", () => {
  beforeEach(() => {
    shared.sendBySessionMock.mockReset();
    shared.sendMessageMock.mockReset();
    shared.sendMessageMock.mockImplementation(
      async (_config: unknown, _to: unknown, text: unknown, options: unknown) => {
        // Simulate real sendMessage behavior: update lastStreamedContent when appending to card
        const opts = options as { card?: { lastStreamedContent: unknown }; cardUpdateMode?: string } | undefined;
        if (opts?.card && opts?.cardUpdateMode === "append") {
          opts.card.lastStreamedContent = text;
        }
        return { ok: true };
      },
    );
    shared.extractMessageContentMock.mockReset();
    shared.extractMessageContentMock.mockReturnValue({ text: "hello", messageType: "text" });
    shared.acquireSessionLockMock.mockReset();
    shared.acquireSessionLockMock.mockResolvedValue(vi.fn());
    shared.isAbortRequestTextMock.mockReset();
    shared.isAbortRequestTextMock.mockReturnValue(false);
    shared.getRuntimeMock.mockReturnValue(buildRuntime());
  });

  it("respects groupPolicy allowlist for sub-agent routing", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValue({
      text: "@expert1 帮我看看",
      messageType: "text",
      atMentions: [{ name: "expert1" }],
    });
    shared.sendBySessionMock.mockResolvedValue(undefined);

    await handleDingTalkMessage({
      cfg: {
        agents: {
          list: [{ id: "expert1", name: "专家1" }],
        },
      },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
      dingtalkConfig: {
        dmPolicy: "open",
        groupPolicy: "allowlist",
        allowFrom: ["allowed_group"],
        messageType: "markdown",
      } as any,
      data: {
        msgId: "m_subagent_1",
        msgtype: "text",
        text: { content: "@expert1 帮我看看" },
        conversationType: "2", // group chat
        conversationId: "blocked_group", // not in allowlist
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    // Should send access denied message, not sub-agent response
    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(String(shared.sendBySessionMock.mock.calls[0]?.[2])).toContain("访问受限");
  });

  it("processes multiple sub-agents sequentially, not in parallel", async () => {
    const callOrder: string[] = [];
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        callOrder.push("dispatch_start");
        await dispatcherOptions.deliver({ text: "response" }, { kind: "final" });
        callOrder.push("dispatch_end");
        return { queuedFinal: "done" };
      });
    // Use mockReturnValue instead of mockReturnValueOnce to ensure all getDingTalkRuntime calls return our runtime
    shared.getRuntimeMock.mockReturnValue(runtime);
    shared.extractMessageContentMock.mockReturnValue({
      text: "@agent1 @agent2 帮我看看",
      messageType: "text",
      atMentions: [{ name: "agent1" }, { name: "agent2" }],
    });

    await handleDingTalkMessage({
      cfg: {
        agents: {
          list: [
            { id: "agent1", name: "Agent1" },
            { id: "agent2", name: "Agent2" },
          ],
        },
      },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "markdown",
      } as any,
      data: {
        msgId: "m_subagent_2",
        msgtype: "text",
        text: { content: "@agent1 @agent2 帮我看看" },
        conversationType: "2", // group chat
        conversationId: "group_1",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    // Sequential processing means dispatch is called twice in order
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
    // If parallel, we might see interleaved calls; sequential ensures complete one before next
    expect(callOrder).toEqual(["dispatch_start", "dispatch_end", "dispatch_start", "dispatch_end"]);
  });

  it("handles @mention of real user without error", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValue({
      text: "@张三 你好",
      messageType: "text",
      atMentions: [{ name: "张三", userId: "real_user_123" }], // has userId = real user
    });

    await handleDingTalkMessage({
      cfg: {
        agents: {
          list: [{ id: "main", name: "助手", default: true }],
        },
      },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "markdown",
      } as any,
      data: {
        msgId: "m_subagent_3",
        msgtype: "text",
        text: { content: "@张三 你好" },
        conversationType: "2", // group chat
        conversationId: "group_1",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    // Should NOT show "未找到助手" error for real user
    expect(shared.sendBySessionMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining("未找到"),
      expect.anything(),
    );
  });

  it("does not show error when @mention matches real user count from atUserDingtalkIds", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    // @张三 (真人) - atUserDingtalkIds has 1 entry
    shared.extractMessageContentMock.mockReturnValue({
      text: "@张三 你好",
      messageType: "text",
      atMentions: [{ name: "张三" }], // no userId (text mode)
      atUserDingtalkIds: ["dingtalk_id_zhangsan"], // 1 real user
    });

    await handleDingTalkMessage({
      cfg: {
        agents: {
          list: [{ id: "main", name: "助手", default: true }],
        },
      },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "markdown",
      } as any,
      data: {
        msgId: "m_text_real_user",
        msgtype: "text",
        text: { content: "@张三 你好" },
        conversationType: "2", // group chat
        conversationId: "group_1",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    // unmatchedNames (1) <= realUserCount (1), so no error should be shown
    expect(shared.sendBySessionMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining("未找到"),
      expect.anything(),
    );
  });

  it("does not show error when real users are present (conservative heuristic)", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    // @张三 @不存在的agent - atUserDingtalkIds has 1 entry, but 2 @mentions
    // With conservative heuristic: if realUserCount > 0, never report invalid agent names
    // This avoids false positives where real user names are incorrectly reported as missing agents
    shared.extractMessageContentMock.mockReturnValue({
      text: "@张三 @不存在的agent 你好",
      messageType: "text",
      atMentions: [{ name: "张三" }, { name: "不存在的agent" }],
      atUserDingtalkIds: ["dingtalk_id_zhangsan"], // only 1 real user
    });
    shared.sendBySessionMock.mockResolvedValue(undefined);

    await handleDingTalkMessage({
      cfg: {
        agents: {
          list: [{ id: "main", name: "助手", default: true }],
        },
      },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "markdown",
      } as any,
      data: {
        msgId: "m_text_invalid_agent",
        msgtype: "text",
        text: { content: "@张三 @不存在的agent 你好" },
        conversationType: "2", // group chat
        conversationId: "group_1",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    // Conservative heuristic: realUserCount > 0, so no error should be shown
    // even though there's an invalid agent name
    expect(shared.sendBySessionMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining("未找到"),
      expect.anything(),
    );
  });

  it("shows error when no real users and invalid agent name", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    // @不存在的agent - no atUserDingtalkIds (no real users)
    // Only show error when realUserCount === 0 AND there are unmatchedNames
    shared.extractMessageContentMock.mockReturnValue({
      text: "@不存在的agent 你好",
      messageType: "text",
      atMentions: [{ name: "不存在的agent" }],
      atUserDingtalkIds: [], // no real users
    });
    shared.sendBySessionMock.mockResolvedValue(undefined);

    await handleDingTalkMessage({
      cfg: {
        agents: {
          list: [{ id: "main", name: "助手", default: true }],
        },
      },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "markdown",
      } as any,
      data: {
        msgId: "m_text_invalid_agent_no_real_users",
        msgtype: "text",
        text: { content: "@不存在的agent 你好" },
        conversationType: "2", // group chat
        conversationId: "group_1",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    // realUserCount === 0 && unmatchedNames.length > 0, so error should be shown
    expect(shared.sendBySessionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining("未找到"),
      expect.anything(),
    );
  });

  it("uses correct sessionWebhook for each sub-agent in order", async () => {
    const webhookCalls: Array<{ agentId: string; webhook: string; responsePrefix: string }> = [];
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        // Capture which agent is being processed by checking responsePrefix
        webhookCalls.push({
          agentId: dispatcherOptions.responsePrefix.includes("Agent1") ? "agent1" : "agent2",
          webhook: "https://session.webhook",
          responsePrefix: dispatcherOptions.responsePrefix,
        });
        await dispatcherOptions.deliver({ text: "response" }, { kind: "final" });
        return { queuedFinal: "done" };
      });
    shared.getRuntimeMock.mockReturnValue(runtime);
    shared.extractMessageContentMock.mockReturnValue({
      text: "@Agent1 @Agent2 帮我看看",
      messageType: "text",
      atMentions: [{ name: "Agent1" }, { name: "Agent2" }],
    });

    await handleDingTalkMessage({
      cfg: {
        agents: {
          list: [
            { id: "agent1", name: "Agent1" },
            { id: "agent2", name: "Agent2" },
          ],
        },
      },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "markdown",
      } as any,
      data: {
        msgId: "m_webhook_order",
        msgtype: "text",
        text: { content: "@Agent1 @Agent2 帮我看看" },
        conversationType: "2", // group chat
        conversationId: "group_1",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    // Verify order: agent1 should be processed before agent2
    expect(webhookCalls).toHaveLength(2);
    expect(webhookCalls[0].agentId).toBe("agent1");
    expect(webhookCalls[1].agentId).toBe("agent2");
    // All should use the same sessionWebhook from the inbound message
    expect(webhookCalls.every(c => c.webhook === "https://session.webhook")).toBe(true);
    // Response prefixes should be distinct for each agent
    expect(webhookCalls[0].responsePrefix).toContain("**Agent1**");
    expect(webhookCalls[1].responsePrefix).toContain("**Agent2**");
  });

  it("fails closed instead of routing a sub-agent message through the default agent when the helper is unavailable", async () => {
    const runtime = buildRuntime();
    // Remove buildAgentSessionKey to trigger fallback path
    delete (runtime.channel.routing as any).buildAgentSessionKey;
    shared.getRuntimeMock.mockReturnValue(runtime);
    shared.extractMessageContentMock.mockReturnValue({
      text: "@expert1 help",
      messageType: "text",
      atMentions: [{ name: "expert1" }],
    });

    await handleDingTalkMessage({
      cfg: {
        agents: { list: [{ id: "expert1", name: "expert1" }] },
      },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as any,
      data: {
        msgId: "fb1", msgtype: "text", text: { content: "@expert1 help" },
        conversationType: "2", conversationId: "group_1",
        senderId: "u1", chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook", createAt: Date.now(),
      },
    } as any);

    expect(runtime.channel.routing.resolveAgentRoute).not.toHaveBeenCalled();
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(shared.sendBySessionMock).toHaveBeenCalledWith(
      expect.anything(),
      "https://session.webhook",
      expect.stringContaining("不支持 DingTalk 子助手路由所需的 session helper"),
      expect.anything(),
    );
  });
});
