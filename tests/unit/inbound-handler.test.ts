import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAccessToken } from "../../src/auth";

const shared = vi.hoisted(() => ({
  sendBySessionMock: vi.fn(),
  sendMessageMock: vi.fn(),
  sendProactiveMediaMock: vi.fn(),
  uploadMediaMock: vi.fn(),
  extractMessageContentMock: vi.fn(),
  downloadGroupFileMock: vi.fn(),
  getRuntimeMock: vi.fn(),
  getUnionIdByStaffIdMock: vi.fn(),
  createAICardMock: vi.fn(),
  finishAICardMock: vi.fn(),
  commitAICardBlocksMock: vi.fn(),
  resolveQuotedFileMock: vi.fn(),
  streamAICardMock: vi.fn(),
  formatContentForCardMock: vi.fn((s: string) => s),
  isCardInTerminalStateMock: vi.fn(),
  updateAICardBlockListMock: vi.fn(),
  streamAICardContentMock: vi.fn(),
  clearAICardStreamingContentMock: vi.fn(),
  acquireSessionLockMock: vi.fn(),
  extractAttachmentTextMock: vi.fn(),
  prepareMediaInputMock: vi.fn(),
  resolveOutboundMediaTypeMock: vi.fn(),
  isAbortRequestTextMock: vi.fn(),
}));

vi.mock("axios", () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
    isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
  },
  isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
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
  uploadMedia: shared.uploadMediaMock,
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
  finishAICard: shared.finishAICardMock,
  commitAICardBlocks: shared.commitAICardBlocksMock,
  formatContentForCard: shared.formatContentForCardMock,
  isCardInTerminalState: shared.isCardInTerminalStateMock,
  streamAICard: shared.streamAICardMock,
  updateAICardBlockList: shared.updateAICardBlockListMock,
  streamAICardContent: shared.streamAICardContentMock,
  clearAICardStreamingContent: shared.clearAICardStreamingContentMock,
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
  downloadGroupFile: shared.downloadGroupFileMock,
  getUnionIdByStaffId: shared.getUnionIdByStaffIdMock,
  resolveQuotedFile: shared.resolveQuotedFileMock,
}));

import {
  downloadMedia,
  handleDingTalkMessage,
  resetProactivePermissionHintStateForTest,
} from "../../src/inbound-handler";
import * as messageContextStore from "../../src/message-context-store";
import { clearCardRunRegistryForTest } from "../../src/card/card-run-registry";
import { recordProactiveRiskObservation } from "../../src/proactive-risk-registry";
import {
  clearTargetDirectoryStateCache,
  listKnownGroupTargets,
  listKnownUserTargets,
} from "../../src/targeting/target-directory-store";

const mockedAxiosPost = vi.mocked(axios.post);
const mockedAxiosGet = vi.mocked(axios.get);
const mockedGetAccessToken = vi.mocked(getAccessToken);
const mockedUpsertInboundMessageContext = vi.mocked(
  messageContextStore.upsertInboundMessageContext,
);
const mockedResolveByMsgId = vi.mocked(messageContextStore.resolveByMsgId);
const mockedResolveByAlias = vi.mocked(messageContextStore.resolveByAlias);
const mockedResolveByCreatedAtWindow = vi.mocked(messageContextStore.resolveByCreatedAtWindow);
const TEST_TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-inbound-unit-"));
const STORE_PATH = path.join(TEST_TMP_DIR, "store.json");

function buildRuntime() {
  return {
    channel: {
      routing: {
        resolveAgentRoute: vi
          .fn()
          .mockReturnValue({ agentId: "main", sessionKey: "s1", mainSessionKey: "s1" }),
        buildAgentSessionKey: vi.fn().mockReturnValue("agent-session-key"),
      },
      media: {
        saveMediaBuffer: vi.fn().mockResolvedValue({
          path: "/tmp/.openclaw/media/inbound/test-file.png",
          contentType: "image/png",
        }),
      },
      session: {
        resolveStorePath: vi.fn().mockReturnValue(STORE_PATH),
        readSessionUpdatedAt: vi.fn().mockReturnValue(null),
        recordInboundSession: vi.fn().mockResolvedValue(undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
        formatInboundEnvelope: vi.fn().mockReturnValue("body"),
        finalizeInboundContext: vi.fn().mockReturnValue({ SessionKey: "s1" }),
        dispatchReplyWithBufferedBlockDispatcher: vi
          .fn()
          .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
            await replyOptions?.onReasoningStream?.({ text: "thinking" });
            await dispatcherOptions.deliver({ text: "tool output" }, { kind: "tool" });
            await dispatcherOptions.deliver({ text: "final output" }, { kind: "final" });
            return { queuedFinal: "queued final" };
          }),
      },
    },
  };
}

describe("inbound-handler", () => {
  beforeEach(() => {
    clearTargetDirectoryStateCache();
    const stateDir = path.join(TEST_TMP_DIR, "dingtalk-state");
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore ENOTEMPTY or other errors
    }
    mockedAxiosPost.mockReset();
    mockedAxiosGet.mockReset();
    mockedGetAccessToken.mockReset();
    mockedGetAccessToken.mockResolvedValue("token_abc");
    shared.sendBySessionMock.mockReset();
    shared.sendMessageMock.mockReset();
    shared.sendProactiveMediaMock.mockReset();
    shared.sendProactiveMediaMock.mockResolvedValue({ ok: true });
    shared.prepareMediaInputMock.mockReset();
    shared.prepareMediaInputMock.mockImplementation(async (rawMediaUrl: string) => ({
      path: `/tmp/prepared/${path.basename(rawMediaUrl) || "media.bin"}`,
      cleanup: vi.fn().mockResolvedValue(undefined),
    }));
    shared.resolveOutboundMediaTypeMock.mockReset();
    shared.resolveOutboundMediaTypeMock.mockReturnValue("file");
    shared.sendMessageMock.mockImplementation(
      async (_config: any, _to: any, text: any, options: any) => {
        // Simulate real sendMessage behavior: update lastStreamedContent when appending to card
        if (options?.card && options?.cardUpdateMode === "append") {
          options.card.lastStreamedContent = text;
        }
        return { ok: true };
      },
    );
    shared.extractMessageContentMock.mockReset();
    mockedUpsertInboundMessageContext.mockClear();
    mockedResolveByMsgId.mockClear();
    mockedResolveByAlias.mockClear();
    mockedResolveByCreatedAtWindow.mockClear();
    shared.createAICardMock.mockReset();
    shared.downloadGroupFileMock.mockReset();
    shared.downloadGroupFileMock.mockResolvedValue(null);
    shared.commitAICardBlocksMock.mockReset();
    shared.getUnionIdByStaffIdMock.mockReset();
    shared.getUnionIdByStaffIdMock.mockResolvedValue("union_1");
    shared.resolveQuotedFileMock.mockReset();
    shared.resolveQuotedFileMock.mockResolvedValue(null);
    shared.streamAICardMock.mockReset();
    shared.isCardInTerminalStateMock.mockReset();
    shared.updateAICardBlockListMock.mockReset().mockResolvedValue(undefined);
    shared.streamAICardContentMock.mockReset().mockResolvedValue(undefined);
    shared.clearAICardStreamingContentMock.mockReset().mockResolvedValue(undefined);

    shared.acquireSessionLockMock.mockReset();
    shared.acquireSessionLockMock.mockResolvedValue(vi.fn());
    shared.extractAttachmentTextMock.mockReset();
    shared.extractAttachmentTextMock.mockResolvedValue(null);
    shared.isAbortRequestTextMock.mockReset();
    shared.isAbortRequestTextMock.mockReturnValue(false); // 默认不触发 abort

    shared.getRuntimeMock.mockReturnValue(buildRuntime());
    shared.extractMessageContentMock.mockReturnValue({ text: "hello", messageType: "text" });
    resetProactivePermissionHintStateForTest();
    clearCardRunRegistryForTest();
    messageContextStore.clearMessageContextCacheForTest();
    shared.createAICardMock.mockResolvedValue({
      cardInstanceId: "card_1",
      state: "1",
      lastUpdated: Date.now(),
    });
  });

  it("handleDingTalkMessage markdown flow sends block answers through dispatcher delivery", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
        expect(replyOptions?.disableBlockStreaming).toBe(false);
        await dispatcherOptions.deliver({ text: "阶段性总结" }, { kind: "block" });
        await dispatcherOptions.deliver({ text: "阶段性总结和补充" }, { kind: "final" });
        return { queuedFinal: false };
      });
    fs.rmSync("/tmp/account-store-no-reasoning.json", { force: true });
    fs.rmSync("/tmp/agent-store-no-reasoning.json", { force: true });
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValueOnce("/tmp/account-store-no-reasoning.json")
      .mockReturnValueOnce("/tmp/agent-store-no-reasoning.json");
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "🤔思考中" } as any,
      data: {
        msgId: "m5",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendMessageMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      "user_1",
      "阶段性总结",
      expect.objectContaining({
        storePath: "/tmp/account-store-no-reasoning.json",
        quotedRef: {
          targetDirection: "inbound",
          key: "msgId",
          value: "m5",
        },
      }),
    );
    expect(shared.sendMessageMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      "user_1",
      "和补充",
      expect.objectContaining({
        storePath: "/tmp/account-store-no-reasoning.json",
      }),
    );
  });
  it("handleDingTalkMessage sends DONE in markdown mode when no visible output is produced", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockResolvedValue({ queuedFinal: "" });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
      data: {
        msgId: "m6_markdown_done",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      "user_1",
      "✅ Done",
      expect.objectContaining({
        quotedRef: {
          targetDirection: "inbound",
          key: "msgId",
          value: "m6_markdown_done",
        },
      }),
    );
  });
  it("markdown flow disables block streaming when session reasoning is on", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
        expect(replyOptions?.disableBlockStreaming).toBe(true);
        if (replyOptions?.disableBlockStreaming) {
          await dispatcherOptions.deliver({ text: "reasoning on正常" }, { kind: "final" });
        } else {
          await dispatcherOptions.deliver({
            text: "Reasoning:\n_用户再次要求分步思考后回答\"reasoning on正常\"。系统标注 `Reasoning ON`，需要显式输出内部推理。_",
          }, { kind: "block" });
        }
        return { queuedFinal: false };
      });
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValueOnce("/tmp/account-store-reasoning-on.json")
      .mockReturnValueOnce("/tmp/agent-store-reasoning-on.json");
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    fs.writeFileSync(
      "/tmp/agent-store-reasoning-on.json",
      JSON.stringify({
        s1: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          reasoningLevel: "on",
        },
      }),
    );

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
      data: {
        msgId: "m_markdown_turn_reset",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendMessageMock.mock.calls.map((call: any[]) => call[2])).toEqual(["reasoning on正常"]);
  });
  it("reuses the cached session reasoning level when session updatedAt is unchanged", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
        expect(replyOptions?.disableBlockStreaming).toBe(true);
        await dispatcherOptions.deliver({ text: "reasoning on正常" }, { kind: "final" });
        return { queuedFinal: false };
      });
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValueOnce("/tmp/account-store-reasoning-cache.json")
      .mockReturnValueOnce("/tmp/agent-store-reasoning-cache.json")
      .mockReturnValueOnce("/tmp/account-store-reasoning-cache.json")
      .mockReturnValueOnce("/tmp/agent-store-reasoning-cache.json");
    runtime.channel.session.readSessionUpdatedAt = vi.fn().mockReturnValue(1234567890);
    shared.getRuntimeMock.mockReturnValue(runtime);

    fs.writeFileSync(
      "/tmp/agent-store-reasoning-cache.json",
      JSON.stringify({
        s1: {
          sessionId: "session-1",
          updatedAt: 1234567890,
          reasoningLevel: "on",
        },
      }),
    );

    const readSpy = vi.spyOn(fs, "readFileSync");

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
      data: {
        msgId: "m_reasoning_cache_1",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
      data: {
        msgId: "m_reasoning_cache_2",
        msgtype: "text",
        text: { content: "hello again" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    const readsForAgentStore = readSpy.mock.calls.filter(
      (call) => String(call[0]) === "/tmp/agent-store-reasoning-cache.json",
    );
    expect(readsForAgentStore).toHaveLength(1);
  });
  it("logs session reasoning read failures with a neutral session prefix", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "最终答案", mediaUrls: [] }, { kind: "final" });
        return { queuedFinal: false };
      });
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValueOnce("/tmp/account-store-reasoning-log.json")
      .mockReturnValueOnce("/tmp/missing-agent-store-reasoning-log.json");
    runtime.channel.session.readSessionUpdatedAt = vi.fn().mockReturnValue(1234567890);
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: log as any,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "card",
        ackReaction: "",
      } as any,
      data: {
        msgId: "m_card_reasoning_log_prefix",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    const debugLogs = log.debug.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(
      debugLogs.some((entry) => entry.includes("[DingTalk][Session] Failed to read session reasoning level")),
    ).toBe(true);
  });
  it("does not update the main-session last route for group inbound messages", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        groupPolicy: "allowlist",
        allowFrom: ["cid_group_1"],
        messageType: "markdown",
        ackReaction: "",
      } as any,
      data: {
        msgId: "m_group_last_route",
        msgtype: "text",
        text: { content: "hello group" },
        conversationType: "2",
        conversationId: "cid_group_1",
        conversationTitle: "group-title",
        senderId: "user_1",
        senderNick: "Alice",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(runtime.channel.session.recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "s1",
        updateLastRoute: undefined,
      }),
    );
  });
  it("does not update the main-session last route for non-owner direct messages when a main owner is pinned", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: { session: { dmScope: "main" } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        dmPolicy: "open",
        allowFrom: ["owner_user"],
        messageType: "markdown",
        ackReaction: "",
      } as any,
      data: {
        msgId: "m_dm_non_owner_last_route",
        msgtype: "text",
        text: { content: "hello direct" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "other_user",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(runtime.channel.session.recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "s1",
        updateLastRoute: undefined,
      }),
    );
  });
  it("updates the main-session last route for the pinned owner direct message", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: { session: { dmScope: "main" } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        dmPolicy: "open",
        allowFrom: ["owner_user"],
        messageType: "markdown",
        ackReaction: "",
      } as any,
      data: {
        msgId: "m_dm_owner_last_route",
        msgtype: "text",
        text: { content: "hello owner" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "owner_user",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(runtime.channel.session.recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "s1",
        updateLastRoute: {
          sessionKey: "s1",
          channel: "dingtalk",
          to: "owner_user",
          accountId: "main",
        },
      }),
    );
  });
  it("uses payload.text for outbound reply delivery even when markdown is present", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver(
          { text: "plain text reply", markdown: "stale markdown reply" },
          { kind: "final" },
        );
        return { queuedFinal: false };
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
      data: {
        msgId: "m_payload_text_only",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      "user_1",
      "plain text reply",
      expect.not.objectContaining({ card: expect.anything() }),
    );
    expect(shared.sendMessageMock).not.toHaveBeenCalledWith(
      expect.anything(),
      "user_1",
      "stale markdown reply",
      expect.anything(),
    );
  });
  it("sends proactive permission hint when proactive API risk was observed", async () => {
    recordProactiveRiskObservation({
      accountId: "main",
      targetId: "manager123",
      level: "high",
      reason: "Forbidden.AccessDenied.AccessTokenPermissionDenied",
      source: "proactive-api",
    });
    shared.sendBySessionMock.mockResolvedValue(undefined);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "markdown",
        ackReaction: "",
        proactivePermissionHint: { enabled: true, cooldownHours: 24 },
      } as any,
      data: {
        msgId: "m9",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "manager123",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(String(shared.sendBySessionMock.mock.calls[0]?.[2])).toContain("主动推送可能失败");
  });
  it("sends proactive permission hint only once within cooldown window", async () => {
    recordProactiveRiskObservation({
      accountId: "main",
      targetId: "manager123",
      level: "high",
      reason: "Forbidden.AccessDenied.AccessTokenPermissionDenied",
      source: "proactive-api",
    });
    shared.sendBySessionMock.mockResolvedValue(undefined);

    const params = {
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "markdown",
        ackReaction: "",
        proactivePermissionHint: { enabled: true, cooldownHours: 24 },
      } as any,
      data: {
        msgId: "m10",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "manager123",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any;

    await handleDingTalkMessage(params);
    await handleDingTalkMessage(params);

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
  });
  it("does not send proactive permission hint without proactive API risk observation", async () => {
    shared.sendBySessionMock.mockResolvedValue(undefined);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "markdown",
        ackReaction: "",
        proactivePermissionHint: { enabled: true, cooldownHours: 24 },
      } as any,
      data: {
        msgId: "m11",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "0341234567",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock).not.toHaveBeenCalled();
  });
  it("matches proactive permission hint risk using senderOriginalId when senderStaffId is present", async () => {
    recordProactiveRiskObservation({
      accountId: "main",
      targetId: "raw_sender_1",
      level: "high",
      reason: "Forbidden.AccessDenied.AccessTokenPermissionDenied",
      source: "proactive-api",
    });
    shared.sendBySessionMock.mockResolvedValue(undefined);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "markdown",
        ackReaction: "",
        proactivePermissionHint: { enabled: true, cooldownHours: 24 },
      } as any,
      data: {
        msgId: "m11_raw_id",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "raw_sender_1",
        senderStaffId: "staff_sender_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(String(shared.sendBySessionMock.mock.calls[0]?.[2])).toContain("主动推送可能失败");
  });
  it("injects group turn context prompt with authoritative sender metadata", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "hello group",
      messageType: "text",
      atUserDingtalkIds: ["$:user_a", "$:user_a", "user,bad"],
      atMentions: [{ name: "Alpha助手", userId: "$:agent-a" }],
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { groupPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
      data: {
        msgId: "m_group_turn_ctx",
        msgtype: "text",
        text: { content: "hello group" },
        conversationType: "2",
        conversationId: "cid_group_ctx",
        conversationTitle: "Dev Group",
        senderId: "raw_sender_1",
        senderStaffId: "staff_sender_1",
        senderNick: "Alice",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        GroupSystemPrompt: expect.stringContaining("Current DingTalk group turn context:"),
      }),
    );
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        GroupSystemPrompt: expect.stringContaining("senderDingtalkId: staff_sender_1"),
      }),
    );
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        GroupSystemPrompt: expect.stringContaining("senderName: Alice"),
      }),
    );
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        GroupSystemPrompt: expect.stringContaining(
          "mentionedDingtalkIds: $:user_a, user bad, $:agent-a",
        ),
      }),
    );
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        GroupSystemPrompt: expect.stringContaining("not staff IDs"),
      }),
    );
  });
  it("acquires session lock with the resolved sessionKey", async () => {
    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
      data: {
        msgId: "lock_test",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.acquireSessionLockMock).toHaveBeenCalledTimes(1);
    expect(shared.acquireSessionLockMock).toHaveBeenCalledWith("s1");
  });
  it("cardRealTimeStream=false: finalize keeps the rendered timeline", async () => {
    const card = { cardInstanceId: "card_no_realtime", state: "1", lastUpdated: Date.now() } as any;
    shared.createAICardMock.mockResolvedValueOnce(card);
    shared.isCardInTerminalStateMock.mockReturnValue(false);

    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
        replyOptions?.onReasoningStream?.({ text: "deep thinking about the problem" });
        await new Promise((r) => setTimeout(r, 350));
        await dispatcherOptions.deliver({ text: "Here is the final answer." }, { kind: "final" });
        return {};
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "card",
        cardRealTimeStream: false,
      } as any,
      data: {
        msgId: "mid_norealtime",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
    const finalizeContent = shared.commitAICardBlocksMock.mock.calls[0][1]?.content;
    // Only answer text is included, reasoning blocks are excluded
    expect(finalizeContent).toContain("Here is the final answer.");
    expect(finalizeContent).not.toContain("deep thinking about the problem");
    expect(finalizeContent).not.toContain("> Here is the final answer.");
    expect(finalizeContent).not.toContain("🤔 思考");
  });
  it("learns group/user targets from inbound displayName metadata", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({ text: "hello", messageType: "text" });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "default",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as any,
      data: {
        msgId: "mid_learn_target_1",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "2",
        conversationId: "cid_group_target_1",
        conversationTitle: "Dev Group",
        senderId: "union_user_1",
        senderStaffId: "staff_user_1",
        senderNick: "Alice",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    const groups = listKnownGroupTargets({
      storePath: STORE_PATH,
      accountId: "default",
      query: "Dev Group",
    });
    const users = listKnownUserTargets({
      storePath: STORE_PATH,
      accountId: "default",
      query: "Alice",
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.conversationId).toBe("cid_group_target_1");
    expect(users).toHaveLength(1);
    expect(users[0]?.canonicalUserId).toBe("staff_user_1");
  });
  it("handleDingTalkMessage concatenates extracted attachment text into inboundText", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "[钉钉文档]\n\n",
      messageType: "interactiveCardFile",
      docSpaceId: "space_attach_concat",
      docFileId: "file_attach_concat",
    });
    shared.downloadGroupFileMock.mockResolvedValueOnce({
      path: "/tmp/.openclaw/media/inbound/report.pdf",
      mimeType: "application/pdf",
    });
    shared.extractAttachmentTextMock.mockResolvedValueOnce({
      text: "第一章 概述\n本报告介绍了...",
      sourceType: "pdf",
      truncated: false,
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", clientId: "robot_1" } as any,
      data: {
        msgId: "msg_attach_concat",
        msgtype: "interactiveCard",
        content: {
          fileName: "report.pdf",
          biz_custom_action_url:
            "dingtalk://dingtalkclient/page/yunpan?route=previewDentry&spaceId=space_attach_concat&fileId=file_attach_concat&type=file",
        },
        conversationType: "1",
        conversationId: "cid_dm_attach_concat",
        senderId: "user_1",
        senderStaffId: "staff_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    // The extracted text MUST be concatenated into RawBody/CommandBody
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: expect.stringContaining("[附件内容摘录]"),
      }),
    );
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: expect.stringContaining("第一章 概述\n本报告介绍了..."),
      }),
    );
  });
  it("handleDingTalkMessage downloads quoted file via fileDownloadCode without calling resolveQuotedFile", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    messageContextStore.clearMessageContextCacheForTest();
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "看这个文件",
      messageType: "text",
      quoted: {
        isQuotedFile: true,
        msgId: "file_msg_777",
        fileCreatedAt: 1774356117207,
        fileDownloadCode: "DIRECT_DL_CODE",
        previewFileName: "report.pdf",
        previewMessageType: "file",
      },
    });
    mockedAxiosPost.mockResolvedValueOnce({
      data: { downloadUrl: "https://download.dingtalk.com/file" },
    } as any);
    mockedAxiosGet.mockResolvedValueOnce({
      data: Buffer.from("PDF content"),
      headers: { "content-type": "application/pdf" },
    } as any);
    shared.extractAttachmentTextMock.mockResolvedValueOnce({
      text: "文件内容摘录",
      sourceType: "text",
      truncated: false,
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { groupPolicy: "open", messageType: "markdown", clientId: "robot_1" } as any,
      data: {
        msgId: "m_file_dl_777",
        msgtype: "text",
        text: { content: "看这个文件", isReplyMsg: true },
        conversationType: "2",
        conversationId: "cid_file_dl",
        senderId: "user_1",
        senderStaffId: "staff_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.resolveQuotedFileMock).not.toHaveBeenCalled();
    expect(shared.extractAttachmentTextMock).toHaveBeenCalled();
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: expect.stringContaining("[附件内容摘录]"),
      }),
    );
  });
  it("handleDingTalkMessage skips Step 1 when Step 0 already resolved via fileDownloadCode", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    messageContextStore.clearMessageContextCacheForTest();

    // Pre-seed a cached record so quotedRecord is non-null and has a downloadCode.
    // Without the !fileResolved guard, Step 1 would call downloadMedia with this code.
    messageContextStore.upsertInboundMessageContext({
      storePath: STORE_PATH,
      accountId: "main",
      conversationId: "cid_step1_guard",
      msgId: "file_msg_step1",
      createdAt: Date.now(),
      messageType: "file",
      media: { downloadCode: "CACHED_DL_CODE" },
      ttlMs: 24 * 60 * 60 * 1000,
      topic: null,
    });

    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "看这个文件",
      messageType: "text",
      quoted: {
        isQuotedFile: true,
        msgId: "file_msg_step1",
        fileCreatedAt: 1774356117207,
        fileDownloadCode: "DIRECT_DL_CODE",
        previewFileName: "report.pdf",
        previewMessageType: "file",
      },
    });
    // Step 0 download (DIRECT_DL_CODE)
    mockedAxiosPost.mockResolvedValueOnce({
      data: { downloadUrl: "https://download.dingtalk.com/direct" },
    } as any);
    mockedAxiosGet.mockResolvedValueOnce({
      data: Buffer.from("PDF content"),
      headers: { "content-type": "application/pdf" },
    } as any);
    shared.extractAttachmentTextMock.mockResolvedValueOnce({
      text: "文件内容摘录",
      sourceType: "text",
      truncated: false,
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { groupPolicy: "open", messageType: "markdown", clientId: "robot_1" } as any,
      data: {
        msgId: "m_file_step1_guard",
        msgtype: "text",
        text: {
          content: "看这个文件",
          isReplyMsg: true,
          repliedMsg: {
            msgId: "file_msg_step1",
            senderId: "user_other",
            createdAt: 1774356117207,
            msgType: "file",
            content: {},
          },
        },
        conversationType: "2",
        conversationId: "cid_step1_guard",
        senderId: "user_1",
        senderStaffId: "staff_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    // Step 0 resolved, so Step 1 must NOT call downloadMedia with the cached code.
    expect(mockedAxiosPost).not.toHaveBeenCalledWith(
      "https://api.dingtalk.com/v1.0/robot/messageFiles/download",
      expect.objectContaining({ downloadCode: "CACHED_DL_CODE" }),
      expect.anything(),
    );
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: expect.stringContaining("[附件内容摘录]"),
      }),
    );
  });
  describe("abort pre-lock bypass", () => {
    const baseData = {
      msgId: "abort_m1",
      msgtype: "text",
      text: { content: "停止" },
      conversationType: "1",
      conversationId: "cid_abort",
      senderId: "user_1",
      chatbotUserId: "bot_1",
      sessionWebhook: "https://session.webhook/abort",
      createAt: Date.now(),
    };

    it("bypasses session lock and dispatches when isAbortRequestText returns true", async () => {
      shared.extractMessageContentMock.mockReturnValue({ text: "停止", messageType: "text" });
      shared.isAbortRequestTextMock.mockReturnValue(true);
      shared.sendBySessionMock.mockResolvedValue({ data: {} });

      const rt = buildRuntime();
      vi.mocked(rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementationOnce(
        async ({ dispatcherOptions }: any) => {
          await dispatcherOptions.deliver({ text: "已停止响应" });
          return { queuedFinal: true, counts: { final: 1 } };
        },
      );
      shared.getRuntimeMock.mockReturnValue(rt);

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook/abort",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open" } as any,
        data: baseData,
      } as any);

      // session lock should NOT be acquired
      expect(shared.acquireSessionLockMock).not.toHaveBeenCalled();
      // abort dispatch should be called
      expect(rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
      // abort deliver should call sendBySession
      expect(shared.sendBySessionMock).toHaveBeenCalledWith(
        expect.anything(),
        "https://session.webhook/abort",
        "已停止响应",
        expect.anything(),
      );
    });

    it("falls back to sendMessage when sessionWebhook is absent", async () => {
      shared.extractMessageContentMock.mockReturnValue({ text: "停止", messageType: "text" });
      shared.isAbortRequestTextMock.mockReturnValue(true);
      shared.sendMessageMock.mockResolvedValue({ ok: true });

      const rt = buildRuntime();
      vi.mocked(rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementationOnce(
        async ({ dispatcherOptions }: any) => {
          await dispatcherOptions.deliver({ text: "已停止响应" });
          return { queuedFinal: true, counts: { final: 1 } };
        },
      );
      shared.getRuntimeMock.mockReturnValue(rt);

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "",          // 无 webhook
        log: undefined,
        dingtalkConfig: { dmPolicy: "open" } as any,
        data: { ...baseData, sessionWebhook: "" },
      } as any);

      expect(shared.acquireSessionLockMock).not.toHaveBeenCalled();
      expect(shared.sendMessageMock).toHaveBeenCalledWith(
        expect.anything(),
        "user_1",
        "已停止响应",
        expect.anything(),
      );
    });

    it("acquires session lock normally when isAbortRequestText returns false", async () => {
      shared.extractMessageContentMock.mockReturnValue({ text: "hello", messageType: "text" });
      shared.isAbortRequestTextMock.mockReturnValue(false);

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook/abort",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open" } as any,
        data: baseData,
      } as any);

      expect(shared.acquireSessionLockMock).toHaveBeenCalledTimes(1);
    });

    it("swallows deliver errors in abort path without propagating", async () => {
      shared.extractMessageContentMock.mockReturnValue({ text: "停止", messageType: "text" });
      shared.isAbortRequestTextMock.mockReturnValue(true);
      shared.sendBySessionMock.mockRejectedValue(new Error("network error"));

      const rt = buildRuntime();
      vi.mocked(rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementationOnce(
        async ({ dispatcherOptions }: any) => {
          await dispatcherOptions.deliver({ text: "已停止响应" });
          return { queuedFinal: false, counts: { final: 0 } };
        },
      );
      shared.getRuntimeMock.mockReturnValue(rt);

      // should not throw
      await expect(
        handleDingTalkMessage({
          cfg: {},
          accountId: "main",
          sessionWebhook: "https://session.webhook/abort",
          log: undefined,
          dingtalkConfig: { dmPolicy: "open" } as any,
          data: baseData,
        } as any),
      ).resolves.toBeUndefined();
    });

    it("in card mode, /stop finalizes the card with abort confirmation text (does NOT send a separate plain-text bubble)", async () => {
      // Regression guard against future hoists. /stop in card mode follows the
      // long-standing flow:
      //   1. createAICard runs early (before media download — UX requirement)
      //   2. abort branch detects /stop, captures dispatch text into the card,
      //      then finalizes the card via finishAICard("已停止" / dispatch text)
      // The card MUST be finalized so it doesn't sit in PROCESSING forever, and
      // the abort confirmation must NOT be sent as a separate text bubble (that
      // would leave both an orphan card AND a plain-text message).
      shared.extractMessageContentMock.mockReturnValue({ text: "停止", messageType: "text" });
      shared.isAbortRequestTextMock.mockReturnValue(true);
      shared.createAICardMock.mockResolvedValue({
        cardInstanceId: "card_abort_1",
        outTrackId: "out_abort_1",
        state: "0",
      });

      const rt = buildRuntime();
      vi.mocked(rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementationOnce(
        async ({ dispatcherOptions }: any) => {
          await dispatcherOptions.deliver({ text: "⚙️ Agent was aborted." });
          return { queuedFinal: true, counts: { final: 1 } };
        },
      );
      shared.getRuntimeMock.mockReturnValue(rt);

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook/abort",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open", messageType: "card" } as any,
        data: baseData,
      } as any);

      // session lock should NOT be acquired
      expect(shared.acquireSessionLockMock).not.toHaveBeenCalled();
      // Card mode: createAICard MUST run for /stop (visual feedback + finalize target)
      expect(shared.createAICardMock).toHaveBeenCalledTimes(1);
      // The card MUST be finalized with the abort confirmation text via V2 finalize path
      expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
      expect(shared.commitAICardBlocksMock).toHaveBeenCalledWith(
        expect.objectContaining({ cardInstanceId: "card_abort_1" }),
        expect.objectContaining({
          content: "⚙️ Agent was aborted.",
          blockListJson: expect.stringContaining("⚙️ Agent was aborted."),
        }),
        undefined,
      );
      const abortPayload = shared.commitAICardBlocksMock.mock.calls[0]?.[1];
      expect(JSON.parse(abortPayload?.blockListJson ?? "[]")).toEqual([
        { type: 0, markdown: "⚙️ Agent was aborted." },
      ]);
      expect(shared.finishAICardMock).not.toHaveBeenCalled();
      // No separate plain-text bubble should be sent in card mode
      expect(shared.sendBySessionMock).not.toHaveBeenCalled();
      expect(shared.sendMessageMock).not.toHaveBeenCalled();
    });

    it("strips leading @mention from group message before abort check", async () => {
      // Simulate DingTalk not stripping @BotName from text.content in group chat.
      // isAbortRequestText should only match the bare command ("停止"), not "@Bot 停止".
      shared.extractMessageContentMock.mockReturnValue({ text: "@Bot 停止", messageType: "text" });
      shared.isAbortRequestTextMock.mockImplementation((text: string) => text === "停止");
      shared.sendBySessionMock.mockResolvedValue({ data: {} });

      const rt = buildRuntime();
      vi.mocked(rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementationOnce(
        async ({ dispatcherOptions }: any) => {
          await dispatcherOptions.deliver({ text: "已停止响应" });
          return { queuedFinal: true, counts: { final: 1 } };
        },
      );
      shared.getRuntimeMock.mockReturnValue(rt);

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook/abort",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open" } as any,
        data: {
          ...baseData,
          msgId: "abort_group_mention",
          text: { content: "@Bot 停止" },
          conversationType: "2",
          conversationId: "cid_group_abort",
        },
      } as any);

      // @mention stripped → "停止" matches → session lock should NOT be acquired
      expect(shared.acquireSessionLockMock).not.toHaveBeenCalled();
      expect(rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    });

    it("strips leading @mention from DM message before abort check", async () => {
      // In multi-agent DM, text like "@Agent /stop" must still bypass the session
      // lock after resolveSubAgentRoute returns null for slash commands.
      shared.extractMessageContentMock.mockReturnValue({
        text: "@Agent /stop",
        messageType: "text",
        atMentions: [{ name: "Agent" }],
      });
      shared.isAbortRequestTextMock.mockImplementation((text: string) => text === "/stop");
      shared.sendBySessionMock.mockResolvedValue({ data: {} });

      const rt = buildRuntime();
      vi.mocked(rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementationOnce(
        async ({ dispatcherOptions }: any) => {
          await dispatcherOptions.deliver({ text: "已停止响应" });
          return { queuedFinal: true, counts: { final: 1 } };
        },
      );
      shared.getRuntimeMock.mockReturnValue(rt);

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook/abort",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open" } as any,
        data: {
          ...baseData,
          msgId: "abort_dm_mention",
          text: { content: "@Agent /stop" },
          conversationType: "1",
          conversationId: "cid_dm_abort",
        },
      } as any);

      // @mention stripped in DM → "/stop" matches → session lock should NOT be acquired
      expect(shared.acquireSessionLockMock).not.toHaveBeenCalled();
      expect(rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    });
  });
  it("handleDingTalkMessage does not inject [media_path:] into body — sets MediaPath on ctx instead", async () => {
    // Regression test for sandbox compatibility: the absolute host path must NOT appear
    // in RawBody/CommandBody, because in sandbox mode the LLM cannot access host paths.
    // OpenClaw core translates ctx.MediaPath to a sandbox-relative path via [media attached:].
    // Uses msgtype: "file" to match the actual bug scenario reported in issue #429.
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "<media:file> (report.pdf)",
      messageType: "file",
      mediaPath: "FILE_DOWNLOAD_CODE",
    });
    mockedAxiosPost.mockResolvedValueOnce({
      data: { downloadUrl: "https://download.dingtalk.com/file" },
    } as any);
    mockedAxiosGet.mockResolvedValueOnce({
      data: Buffer.from("%PDF"),
      headers: { "content-type": "application/pdf" },
    } as any);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", clientId: "robot_1" } as any,
      data: {
        msgId: "m_file_sandbox",
        msgtype: "file",
        content: { downloadCode: "FILE_DOWNLOAD_CODE", fileName: "report.pdf" },
        conversationType: "1",
        conversationId: "cid_dm_file",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    const finalized = runtime.channel.reply.finalizeInboundContext.mock.calls[0]?.[0];

    // [media_path:] must NOT appear in body — it exposes the host absolute path which
    // breaks sandbox mode. OpenClaw handles path translation via ctx.MediaPath.
    expect(finalized.RawBody).not.toContain("[media_path:");
    expect(finalized.CommandBody).not.toContain("[media_path:");

    // ctx.MediaPath must still be set so OpenClaw can generate [media attached: relative/path]
    expect(finalized.MediaPath).toContain("/.openclaw/media/inbound/");
  });
});
