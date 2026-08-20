import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DingTalkConfig } from "../../src/types";

const shared = vi.hoisted(() => ({
  getRuntimeMock: vi.fn(),
  extractMessageContentMock: vi.fn(),
  downloadGroupFileMock: vi.fn(),
  getUnionIdByStaffIdMock: vi.fn(),
  resolveQuotedFileMock: vi.fn(),
  extractAttachmentTextMock: vi.fn(),
  createAICardMock: vi.fn(),
  sendMessageMock: vi.fn(),
  sendBySessionMock: vi.fn(),
  commitAICardBlocksMock: vi.fn(),
  streamAICardMock: vi.fn(),
  isCardInTerminalStateMock: vi.fn(),
  updateAICardBlockListMock: vi.fn(),
  streamAICardContentMock: vi.fn(),
  clearAICardStreamingContentMock: vi.fn(),
  acquireSessionLockMock: vi.fn(),
  prepareMediaInputMock: vi.fn(),
  resolveOutboundMediaTypeMock: vi.fn(),
  isAbortRequestTextMock: vi.fn(),
  formatContentForCardMock: vi.fn((s: string) => s),
  sendProactiveMediaMock: vi.fn(),
  uploadMediaMock: vi.fn(),
  formatInboundEnvelopeMock: vi.fn().mockReturnValue("body"),
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

vi.mock("../../src/messaging/quoted-file-service", () => ({
  downloadGroupFile: shared.downloadGroupFileMock,
  getUnionIdByStaffId: shared.getUnionIdByStaffIdMock,
  resolveQuotedFile: shared.resolveQuotedFileMock,
}));

vi.mock("../../src/send-service", () => ({
  sendBySession: shared.sendBySessionMock,
  sendMessage: shared.sendMessageMock,
  sendProactiveMedia: shared.sendProactiveMediaMock,
  uploadMedia: shared.uploadMediaMock,
}));

vi.mock("../../src/card-service", () => ({
  createAICard: shared.createAICardMock,
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

vi.mock("../../src/media-utils", async () => {
  const actual = await vi.importActual<typeof import("../../src/media-utils")>("../../src/media-utils");
  return {
    ...actual,
    prepareMediaInput: shared.prepareMediaInputMock,
    resolveOutboundMediaType: shared.resolveOutboundMediaTypeMock,
  };
});

vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  isAbortRequestText: shared.isAbortRequestTextMock,
  isBtwRequestText: vi.fn().mockReturnValue(false),
}));

// `formatInboundEnvelope` moved out of the runtime facade into the
// `channel-inbound` SDK subpath (OpenClaw 2026.8.x).
vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
  formatInboundEnvelope: shared.formatInboundEnvelopeMock,
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

import { handleDingTalkMessage, resetProactivePermissionHintStateForTest } from "../../src/inbound-handler";
import * as messageContextStore from "../../src/message-context-store";
import { clearCardRunRegistryForTest } from "../../src/card/card-run-registry";
import {
  clearTargetDirectoryStateCache,
} from "../../src/targeting/target-directory-store";

const mockedUpsertInboundMessageContext = vi.mocked(messageContextStore.upsertInboundMessageContext);
const mockedResolveByMsgId = vi.mocked(messageContextStore.resolveByMsgId);
const mockedResolveByAlias = vi.mocked(messageContextStore.resolveByAlias);
const mockedResolveByCreatedAtWindow = vi.mocked(messageContextStore.resolveByCreatedAtWindow);
const TEST_TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-quote-unit-"));
const STORE_PATH = path.join(TEST_TMP_DIR, "store.json");
const ACCOUNT_STORE_PATH = path.join(TEST_TMP_DIR, "account-store.json");
const AGENT_STORE_PATH = path.join(TEST_TMP_DIR, "agent-store.json");
const DM_ACCOUNT_STORE_PATH = path.join(TEST_TMP_DIR, "dm-account-store.json");
const DM_AGENT_STORE_PATH = path.join(TEST_TMP_DIR, "dm-agent-store.json");

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

describe("inbound-handler quote handling", () => {
  beforeEach(() => {
    clearTargetDirectoryStateCache();
    // Use rimraf-style cleanup: retry on ENOTEMPTY
    const stateDir = path.join(TEST_TMP_DIR, "dingtalk-state");
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch (e) {
      // On some platforms, recursive rm may fail on non-empty dirs; retry once
      if ((e as NodeJS.ErrnoException).code === "ENOTEMPTY") {
        fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
    shared.getRuntimeMock.mockReset();
    shared.formatInboundEnvelopeMock.mockReset();
    shared.formatInboundEnvelopeMock.mockReturnValue("body");
    shared.extractMessageContentMock.mockReset();
    shared.downloadGroupFileMock.mockReset();
    shared.downloadGroupFileMock.mockResolvedValue(null);
    shared.getUnionIdByStaffIdMock.mockReset();
    shared.getUnionIdByStaffIdMock.mockResolvedValue("union_1");
    shared.resolveQuotedFileMock.mockReset();
    shared.resolveQuotedFileMock.mockResolvedValue(null);
    shared.extractAttachmentTextMock.mockReset();
    shared.extractAttachmentTextMock.mockResolvedValue(null);
    shared.createAICardMock.mockReset();
    shared.createAICardMock.mockResolvedValue({
      cardInstanceId: "card_1",
      state: "1",
      lastUpdated: Date.now(),
    });
    shared.sendMessageMock.mockReset();
    shared.sendMessageMock.mockImplementation(
      async (_config: unknown, _to: unknown, text: unknown, options: { card?: { lastStreamedContent?: unknown }; cardUpdateMode?: string }) => {
        if (options?.card && options?.cardUpdateMode === "append") {
          options.card.lastStreamedContent = text;
        }
        return { ok: true };
      },
    );
    shared.sendBySessionMock.mockReset();
    shared.commitAICardBlocksMock.mockReset();
    shared.streamAICardMock.mockReset();
    shared.isCardInTerminalStateMock.mockReset();
    shared.updateAICardBlockListMock.mockReset().mockResolvedValue(undefined);
    shared.streamAICardContentMock.mockReset().mockResolvedValue(undefined);
    shared.clearAICardStreamingContentMock.mockReset().mockResolvedValue(undefined);
    shared.acquireSessionLockMock.mockReset();
    shared.acquireSessionLockMock.mockResolvedValue(vi.fn());
    shared.prepareMediaInputMock.mockReset();
    shared.prepareMediaInputMock.mockImplementation(async (rawMediaUrl: string) => ({
      path: `/tmp/prepared/${path.basename(rawMediaUrl) || "media.bin"}`,
      cleanup: vi.fn().mockResolvedValue(undefined),
    }));
    shared.resolveOutboundMediaTypeMock.mockReset();
    shared.resolveOutboundMediaTypeMock.mockReturnValue("file");
    shared.isAbortRequestTextMock.mockReset();
    shared.isAbortRequestTextMock.mockReturnValue(false);
    shared.sendProactiveMediaMock.mockReset();
    shared.sendProactiveMediaMock.mockResolvedValue({ ok: true });
    shared.uploadMediaMock.mockReset();
    shared.formatContentForCardMock.mockImplementation((s: string) => s);

    mockedUpsertInboundMessageContext.mockClear();
    mockedResolveByMsgId.mockClear();
    mockedResolveByAlias.mockClear();
    mockedResolveByCreatedAtWindow.mockClear();

    shared.getRuntimeMock.mockReturnValue(buildRuntime());
    shared.extractMessageContentMock.mockReturnValue({ text: "hello", messageType: "text" });
    resetProactivePermissionHintStateForTest();
    clearCardRunRegistryForTest();
    messageContextStore.clearMessageContextCacheForTest();
  });

  describe("quote journal and quotedRef recording", () => {
    it("appends inbound quote journal entry with store/account/session context", async () => {
      const runtime = buildRuntime();
      runtime.channel.session.resolveStorePath = vi
        .fn()
        .mockReturnValueOnce(ACCOUNT_STORE_PATH)
        .mockReturnValueOnce(AGENT_STORE_PATH);
      shared.getRuntimeMock.mockReturnValueOnce(runtime);

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown", journalTTLDays: 9 } as unknown as DingTalkConfig,
        data: {
          msgId: "m_journal_1",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: 1700000000000,
        },
      } as unknown as { data: unknown });

      expect(mockedUpsertInboundMessageContext).toHaveBeenCalledWith(
        expect.objectContaining({
          storePath: ACCOUNT_STORE_PATH,
          accountId: "main",
          conversationId: "cid_ok",
          msgId: "m_journal_1",
          messageType: "text",
          text: "hello",
          createdAt: 1700000000000,
          cleanupCreatedAtTtlDays: 9,
        }),
      );
    });

    it("records inbound quotedRef for text replies without injecting quoted text", async () => {
      const runtime = buildRuntime();
      runtime.channel.session.resolveStorePath = vi
        .fn()
        .mockReturnValueOnce(DM_ACCOUNT_STORE_PATH)
        .mockReturnValueOnce(DM_AGENT_STORE_PATH);
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "hello",
        messageType: "text",
        quoted: {
          msgId: "orig_msg_001",
        },
      });

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown", journalTTLDays: 11 } as unknown as DingTalkConfig,
        data: {
          msgId: "m_quote_1",
          msgtype: "text",
          text: { content: "hello", isReplyMsg: true },
          originalMsgId: "orig_msg_001",
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      expect(mockedUpsertInboundMessageContext).toHaveBeenCalledWith(
        expect.objectContaining({
          storePath: DM_ACCOUNT_STORE_PATH,
          msgId: "m_quote_1",
          text: "hello",
          quotedRef: {
            targetDirection: "inbound",
            key: "msgId",
            value: "orig_msg_001",
          },
        }),
      );
      expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
        expect.objectContaining({
          RawBody: "hello",
          CommandBody: "hello",
          QuotedRef: {
            targetDirection: "inbound",
            key: "msgId",
            value: "orig_msg_001",
          },
          QuotedRefJson: '{"targetDirection":"inbound","key":"msgId","value":"orig_msg_001"}',
        }),
      );
    });

    it("writes normalized inbound journal text without quoted prefix noise", async () => {
      const runtime = buildRuntime();
      runtime.channel.session.resolveStorePath = vi
        .fn()
        .mockReturnValueOnce(DM_ACCOUNT_STORE_PATH)
        .mockReturnValueOnce(DM_AGENT_STORE_PATH);
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "真正正文",
        messageType: "text",
      });

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_prefixed_1",
          msgtype: "text",
          text: { content: "真正正文", isReplyMsg: true },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: 1700000000000,
        },
      } as unknown as { data: unknown });

      expect(mockedUpsertInboundMessageContext).toHaveBeenCalledWith(
        expect.objectContaining({
          storePath: DM_ACCOUNT_STORE_PATH,
          text: "真正正文",
        }),
      );
    });

    it("uses DingTalk DM conversationId for journal writes instead of senderId", async () => {
      const runtime = buildRuntime();
      runtime.channel.session.resolveStorePath = vi
        .fn()
        .mockReturnValueOnce(DM_ACCOUNT_STORE_PATH)
        .mockReturnValueOnce(DM_AGENT_STORE_PATH);
      shared.getRuntimeMock.mockReturnValueOnce(runtime);

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_dm_1",
          msgtype: "text",
          text: { content: "hello dm" },
          conversationType: "1",
          conversationId: "cid_dm_stable",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: 1700000000000,
        },
      } as unknown as { data: unknown });

      expect(mockedUpsertInboundMessageContext).toHaveBeenCalledWith(
        expect.objectContaining({
          storePath: DM_ACCOUNT_STORE_PATH,
          conversationId: "cid_dm_stable",
        }),
      );
      expect(mockedUpsertInboundMessageContext).not.toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "user_1",
        }),
      );
    });

    it("keeps literal quote marker text in body while tracking quotedRef separately", async () => {
      const runtime = buildRuntime();
      runtime.channel.session.resolveStorePath = vi
        .fn()
        .mockReturnValueOnce(DM_ACCOUNT_STORE_PATH)
        .mockReturnValueOnce(DM_AGENT_STORE_PATH);
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "我在讨论字符串 [引用消息:] 本身",
        messageType: "text",
        quoted: {
          msgId: "orig_msg_literal",
        },
      });

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_literal_1",
          msgtype: "text",
          text: { content: "我在讨论字符串 [引用消息:] 本身", isReplyMsg: true },
          originalMsgId: "orig_msg_literal",
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      const envelopeArg = shared.formatInboundEnvelopeMock.mock.calls[0]?.[0];
      expect(envelopeArg.body).toContain("我在讨论字符串 [引用消息:] 本身");
      expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
        expect.objectContaining({
          RawBody: "我在讨论字符串 [引用消息:] 本身",
          QuotedRef: {
            targetDirection: "inbound",
            key: "msgId",
            value: "orig_msg_literal",
          },
        }),
      );
    });

    it("logs legacy quoteContent when no resolvable quotedRef can be built", async () => {
      const runtime = buildRuntime();
      runtime.channel.session.resolveStorePath = vi
        .fn()
        .mockReturnValueOnce(DM_ACCOUNT_STORE_PATH)
        .mockReturnValueOnce(DM_AGENT_STORE_PATH);
      const log = {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
      };
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "当前消息",
        messageType: "text",
      });

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log,
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_legacy_quote_1",
          msgtype: "text",
          text: { content: "当前消息" },
          content: { quoteContent: "旧引用正文" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      expect(log.debug).toHaveBeenCalledWith(
        expect.stringContaining("Legacy quoteContent present without resolvable quotedRef"),
      );
      expect(mockedUpsertInboundMessageContext).toHaveBeenCalledWith(
        expect.objectContaining({
          msgId: "m_legacy_quote_1",
          text: "当前消息",
          quotedRef: undefined,
        }),
      );
    });

    it("sets quoteContent to inbound message text even without quotedRef", async () => {
      const runtime = buildRuntime();
      runtime.channel.session.resolveStorePath = vi
        .fn()
        .mockReturnValueOnce(DM_ACCOUNT_STORE_PATH)
        .mockReturnValueOnce(DM_AGENT_STORE_PATH);
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "你好世界",
        messageType: "text",
      });
      shared.createAICardMock.mockResolvedValueOnce({
        cardInstanceId: "card_test",
        outTrackId: "card_test",
        state: "1",
        lastUpdated: Date.now(),
      });

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open", messageType: "card" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_quote_test",
          text: { content: " 你好世界" },
          conversationType: "2",
          conversationId: "cid_quote_test",
          msgtype: "text",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      expect(shared.createAICardMock).toHaveBeenCalledTimes(1);
      const callArgs = shared.createAICardMock.mock.calls[0];
      const options = callArgs[3] as { quoteContent?: string };
      expect(options.quoteContent).toBe("你好世界");
    });
  });

  describe("ReplyTo field injection", () => {
    it("injects ReplyTo fields for quoted inbound text while keeping RawBody on the current message", async () => {
      const baseTs = Date.now();
      const runtime = buildRuntime();
      runtime.channel.session.resolveStorePath = vi
        .fn()
        .mockReturnValueOnce(STORE_PATH)
        .mockReturnValueOnce(AGENT_STORE_PATH);
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      messageContextStore.upsertInboundMessageContext({
        storePath: STORE_PATH,
        accountId: "main",
        conversationId: "cid_ok",
        msgId: "orig_msg_002",
        createdAt: baseTs - 1000,
        messageType: "text",
        text: "原始引用正文",
        topic: null,
      });
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "当前回复",
        messageType: "text",
        quoted: {
          msgId: "orig_msg_002",
        },
      });
      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_quote_reply_2",
          msgtype: "text",
          text: { content: "当前回复", isReplyMsg: true },
          originalMsgId: "orig_msg_002",
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: baseTs,
        },
      } as unknown as { data: unknown });

      const finalized = runtime.channel.reply.finalizeInboundContext.mock.calls[0]?.[0];
      expect(finalized.QuotedRef).toEqual({
        targetDirection: "inbound",
        key: "msgId",
        value: "orig_msg_002",
      });
      expect(finalized.RawBody).toBe("当前回复");
      expect(finalized.CommandBody).toBe("当前回复");
      expect(finalized.ReplyToId).toBe("orig_msg_002");
      expect(finalized.ReplyToBody).toBe("原始引用正文");
      expect(finalized.ReplyToSender).toBeUndefined();
      expect(finalized.ReplyToIsQuote).toBe(true);
      expect(finalized.UntrustedContext).toBeUndefined();
    });

    it("injects ReplyTo fields for quoted outbound cards via processQueryKey", async () => {
      const baseTs = Date.now();
      const runtime = buildRuntime();
      runtime.channel.session.resolveStorePath = vi
        .fn()
        .mockReturnValueOnce(STORE_PATH)
        .mockReturnValueOnce(AGENT_STORE_PATH);
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      messageContextStore.upsertOutboundMessageContext({
        storePath: STORE_PATH,
        accountId: "main",
        conversationId: "cid_ok",
        createdAt: baseTs - 1000,
        messageType: "interactiveCard",
        text: "机器人上一条卡片回复",
        topic: null,
        delivery: {
          processQueryKey: "carrier_quoted_2",
          messageId: "out_msg_2",
          kind: "session",
        },
      });
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "继续",
        messageType: "text",
        quoted: {
          isQuotedCard: true,
          processQueryKey: "carrier_quoted_2",
        },
      });

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as unknown as DingTalkConfig,
        data: {
          msgId: "m5_card_quote_2",
          msgtype: "text",
          text: { content: "继续", isReplyMsg: true },
          originalProcessQueryKey: "carrier_quoted_2",
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: baseTs,
        },
      } as unknown as { data: unknown });

      const finalized = runtime.channel.reply.finalizeInboundContext.mock.calls[0]?.[0];
      expect(finalized.ReplyToId).toBe("carrier_quoted_2");
      expect(finalized.ReplyToBody).toBe("机器人上一条卡片回复");
      expect(finalized.ReplyToSender).toBe("assistant");
      expect(finalized.ReplyToIsQuote).toBe(true);
    });

    it("uses a stable placeholder when the first quoted hop has no text", async () => {
      const baseTs = Date.now();
      const runtime = buildRuntime();
      runtime.channel.session.resolveStorePath = vi
        .fn()
        .mockReturnValueOnce(STORE_PATH)
        .mockReturnValueOnce(AGENT_STORE_PATH);
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      messageContextStore.upsertOutboundMessageContext({
        storePath: STORE_PATH,
        accountId: "main",
        conversationId: "cid_ok",
        createdAt: baseTs - 1000,
        messageType: "interactiveCardFile",
        topic: null,
        delivery: {
          processQueryKey: "carrier_placeholder_1",
          kind: "session",
        },
      });
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "看看这个",
        messageType: "text",
        quoted: {
          isQuotedCard: true,
          processQueryKey: "carrier_placeholder_1",
        },
      });

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_quote_placeholder",
          msgtype: "text",
          text: { content: "看看这个", isReplyMsg: true },
          originalProcessQueryKey: "carrier_placeholder_1",
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: baseTs,
        },
      } as unknown as { data: unknown });

      const finalized = runtime.channel.reply.finalizeInboundContext.mock.calls[0]?.[0];
      expect(finalized.ReplyToBody).toBe("[Quoted interactiveCardFile]");
      expect(finalized.UntrustedContext).toBeUndefined();
    });

    it("uses cached attachment excerpts as ReplyToBody for quoted document messages", async () => {
      const baseTs = Date.now();
      const runtime = buildRuntime();
      runtime.channel.session.resolveStorePath = vi
        .fn()
        .mockReturnValueOnce(STORE_PATH)
        .mockReturnValueOnce(AGENT_STORE_PATH);
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      messageContextStore.upsertInboundMessageContext({
        storePath: STORE_PATH,
        accountId: "main",
        conversationId: "cid_ok",
        msgId: "quoted_doc_1",
        createdAt: baseTs - 1000,
        messageType: "interactiveCardFile",
        text: "[钉钉文档]",
        attachmentText: "这是从 PDF 抽出的首段正文",
        attachmentTextSource: "pdf",
        attachmentFileName: "manual.pdf",
        topic: null,
      });
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "继续读这个文档",
        messageType: "text",
        quoted: {
          msgId: "quoted_doc_1",
          previewText: "[钉钉文档]",
          previewMessageType: "interactiveCardFile",
        },
      });

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_quote_doc_excerpt_1",
          msgtype: "text",
          text: { content: "继续读这个文档", isReplyMsg: true },
          originalMsgId: "quoted_doc_1",
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: baseTs,
        },
      } as unknown as { data: unknown });

      const finalized = runtime.channel.reply.finalizeInboundContext.mock.calls[0]?.[0];
      expect(finalized.ReplyToBody).toBe("这是从 PDF 抽出的首段正文");
    });

    it("injects single-hop ReplyTo fields from quoted preview when the store misses", async () => {
      const runtime = buildRuntime();
      runtime.channel.session.resolveStorePath = vi
        .fn()
        .mockReturnValueOnce(STORE_PATH)
        .mockReturnValueOnce(AGENT_STORE_PATH);
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "继续这个话题",
        messageType: "text",
        quoted: {
          msgId: "missing_preview_msg",
          previewText: "这是事件里自带的一跳引用预览",
          previewMessageType: "text",
        },
      });

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_quote_preview_only_1",
          msgtype: "text",
          text: { content: "继续这个话题", isReplyMsg: true },
          originalMsgId: "missing_preview_msg",
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      const finalized = runtime.channel.reply.finalizeInboundContext.mock.calls[0]?.[0];
      expect(finalized.ReplyToId).toBe("missing_preview_msg");
      expect(finalized.ReplyToBody).toBe("这是事件里自带的一跳引用预览");
      expect(finalized.ReplyToSender).toBeUndefined();
      expect(finalized.ReplyToIsQuote).toBe(true);
      expect(finalized.UntrustedContext).toBeUndefined();
    });

    it("does not inject ReplyTo fields or chain context when quotedRef cannot be resolved", async () => {
      const runtime = buildRuntime();
      runtime.channel.session.resolveStorePath = vi
        .fn()
        .mockReturnValueOnce(STORE_PATH)
        .mockReturnValueOnce(AGENT_STORE_PATH);
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "找不到引用",
        messageType: "text",
        quoted: {
          msgId: "missing_quote_msg",
        },
      });

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_quote_missing_1",
          msgtype: "text",
          text: { content: "找不到引用", isReplyMsg: true },
          originalMsgId: "missing_quote_msg",
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: 1700000040000,
        },
      } as unknown as { data: unknown });

      const finalized = runtime.channel.reply.finalizeInboundContext.mock.calls[0]?.[0];
      expect(finalized.ReplyToId).toBeUndefined();
      expect(finalized.ReplyToBody).toBeUndefined();
      expect(finalized.ReplyToSender).toBeUndefined();
      expect(finalized.ReplyToIsQuote).toBeUndefined();
      expect(finalized.UntrustedContext).toBeUndefined();
    });
  });

  describe("multi-hop chain handling", () => {
    it("injects a single JSON UntrustedContext block for multi-hop quoted chains starting at hop 2", async () => {
      const baseTs = Date.now();
      const runtime = buildRuntime();
      runtime.channel.session.resolveStorePath = vi
        .fn()
        .mockReturnValueOnce(STORE_PATH)
        .mockReturnValueOnce(AGENT_STORE_PATH);
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      messageContextStore.upsertInboundMessageContext({
        storePath: STORE_PATH,
        accountId: "main",
        conversationId: "cid_ok",
        msgId: "chain_leaf_1",
        createdAt: baseTs - 3000,
        messageType: "text",
        text: "第三跳原文",
        topic: null,
      });
      messageContextStore.upsertOutboundMessageContext({
        storePath: STORE_PATH,
        accountId: "main",
        conversationId: "cid_ok",
        createdAt: baseTs - 2000,
        messageType: "markdown",
        text: "第二跳原文",
        quotedRef: {
          targetDirection: "inbound",
          key: "msgId",
          value: "chain_leaf_1",
        },
        topic: null,
        delivery: {
          processQueryKey: "chain_mid_1",
          kind: "session",
        },
      });
      messageContextStore.upsertInboundMessageContext({
        storePath: STORE_PATH,
        accountId: "main",
        conversationId: "cid_ok",
        msgId: "chain_head_1",
        createdAt: baseTs - 1000,
        messageType: "text",
        text: "第一跳原文",
        quotedRef: {
          targetDirection: "outbound",
          key: "processQueryKey",
          value: "chain_mid_1",
        },
        topic: null,
      });
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "当前消息",
        messageType: "text",
        quoted: {
          msgId: "chain_head_1",
        },
      });

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_quote_chain_1",
          msgtype: "text",
          text: { content: "当前消息", isReplyMsg: true },
          originalMsgId: "chain_head_1",
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: baseTs,
        },
      } as unknown as { data: unknown });

      const finalized = runtime.channel.reply.finalizeInboundContext.mock.calls[0]?.[0];
      expect(finalized.ReplyToBody).toBe("第一跳原文");
      expect(finalized.UntrustedContext).toHaveLength(1);
      const untrusted = JSON.parse(finalized.UntrustedContext[0]);
      expect(untrusted).toEqual({
        quotedChain: [
          {
            depth: 2,
            direction: "outbound",
            messageType: "markdown",
            sender: "assistant",
            body: "第二跳原文",
            createdAt: baseTs - 2000,
          },
          {
            depth: 3,
            direction: "inbound",
            messageType: "text",
            body: "第三跳原文",
            createdAt: baseTs - 3000,
          },
        ],
      });
    });

    it("stops safely when a quoted chain loops back to an earlier hop", async () => {
      const baseTs = Date.now();
      const runtime = buildRuntime();
      runtime.channel.session.resolveStorePath = vi
        .fn()
        .mockReturnValueOnce(STORE_PATH)
        .mockReturnValueOnce(AGENT_STORE_PATH);
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      messageContextStore.upsertOutboundMessageContext({
        storePath: STORE_PATH,
        accountId: "main",
        conversationId: "cid_ok",
        createdAt: baseTs - 1000,
        messageType: "markdown",
        text: "第二跳循环",
        quotedRef: {
          targetDirection: "inbound",
          key: "msgId",
          value: "cycle_head_1",
        },
        topic: null,
        delivery: {
          processQueryKey: "cycle_mid_1",
          kind: "session",
        },
      });
      messageContextStore.upsertInboundMessageContext({
        storePath: STORE_PATH,
        accountId: "main",
        conversationId: "cid_ok",
        msgId: "cycle_head_1",
        createdAt: baseTs - 2000,
        messageType: "text",
        text: "第一跳循环",
        quotedRef: {
          targetDirection: "outbound",
          key: "processQueryKey",
          value: "cycle_mid_1",
        },
        topic: null,
      });
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "循环测试",
        messageType: "text",
        quoted: {
          msgId: "cycle_head_1",
        },
      });

      await expect(
        handleDingTalkMessage({
          cfg: {},
          accountId: "main",
          sessionWebhook: "https://session.webhook",
          log: undefined,
          dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as unknown as DingTalkConfig,
          data: {
            msgId: "m_quote_cycle_1",
            msgtype: "text",
            text: { content: "循环测试", isReplyMsg: true },
            originalMsgId: "cycle_head_1",
            conversationType: "1",
            conversationId: "cid_ok",
            senderId: "user_1",
            chatbotUserId: "bot_1",
            sessionWebhook: "https://session.webhook",
            createAt: baseTs,
          },
        } as unknown as { data: unknown }),
      ).resolves.toBeUndefined();

      const finalized = runtime.channel.reply.finalizeInboundContext.mock.calls[0]?.[0];
      expect(finalized.ReplyToBody).toBe("第一跳循环");
      expect(JSON.parse(finalized.UntrustedContext[0])).toEqual({
        quotedChain: [
          {
            depth: 2,
            direction: "outbound",
            messageType: "markdown",
            sender: "assistant",
            body: "第二跳循环",
            createdAt: baseTs - 1000,
          },
        ],
      });
    });
  });

  describe("quoted card tracking", () => {
    it("tracks outbound quoted card by processQueryKey without injecting card text", async () => {
      const runtime = buildRuntime();
      runtime.channel.session.resolveStorePath = vi
        .fn()
        .mockReturnValueOnce(ACCOUNT_STORE_PATH)
        .mockReturnValueOnce(AGENT_STORE_PATH);
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "hello",
        messageType: "text",
        quoted: {
          isQuotedCard: true,
          processQueryKey: "carrier_quoted_1",
        },
      });

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as unknown as DingTalkConfig,
        data: {
          msgId: "m5_card_quote",
          msgtype: "text",
          text: { content: "hello", isReplyMsg: true },
          originalProcessQueryKey: "carrier_quoted_1",
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      expect(mockedResolveByAlias).not.toHaveBeenCalled();
      expect(mockedUpsertInboundMessageContext).toHaveBeenCalledWith(
        expect.objectContaining({
          msgId: "m5_card_quote",
          text: "hello",
          quotedRef: {
            targetDirection: "outbound",
            key: "processQueryKey",
            value: "carrier_quoted_1",
          },
        }),
      );
      expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
        expect.objectContaining({
          RawBody: "hello",
          QuotedRef: {
            targetDirection: "outbound",
            key: "processQueryKey",
            value: "carrier_quoted_1",
          },
          QuotedRefJson: '{"targetDirection":"outbound","key":"processQueryKey","value":"carrier_quoted_1"}',
        }),
      );
    });

    it("records outbound createdAt fallback when quoted card key is missing", async () => {
      const runtime = buildRuntime();
      runtime.channel.session.resolveStorePath = vi
        .fn()
        .mockReturnValueOnce(ACCOUNT_STORE_PATH)
        .mockReturnValueOnce(AGENT_STORE_PATH);
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "hello",
        messageType: "text",
        quoted: {
          isQuotedCard: true,
          cardCreatedAt: 1772817989679,
          previewText: "机器人上一条卡片回复（预览）",
          previewMessageType: "interactiveCard",
          previewSenderId: "bot_1",
        },
      });

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as unknown as DingTalkConfig,
        data: {
          msgId: "m5_card_fallback",
          msgtype: "text",
          text: { content: "hello", isReplyMsg: true },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      expect(mockedResolveByAlias).not.toHaveBeenCalled();
      expect(mockedResolveByCreatedAtWindow).not.toHaveBeenCalled();
      expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
        expect.objectContaining({
          RawBody: "hello",
          ReplyToId: undefined,
          ReplyToBody: "机器人上一条卡片回复（预览）",
          ReplyToSender: "assistant",
          QuotedRef: {
            targetDirection: "outbound",
            fallbackCreatedAt: 1772817989679,
          },
          QuotedRefJson: '{"targetDirection":"outbound","fallbackCreatedAt":1772817989679}',
        }),
      );
    });
  });

  describe("quoted file/document handling", () => {
    it("persists group quoted file metadata after API fallback succeeds", async () => {
      const runtime = buildRuntime();
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "群聊文件",
        messageType: "text",
        quoted: {
          isQuotedFile: true,
          msgId: "group_file_msg_1",
          fileCreatedAt: 1772863284581,
        },
      });
      shared.resolveQuotedFileMock.mockResolvedValueOnce({
        media: {
          path: "/tmp/.openclaw/media/inbound/group-file.bin",
          mimeType: "application/octet-stream",
        },
        spaceId: "space_group_1",
        fileId: "dentry_group_1",
        name: "a.sql",
      });

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown", clientId: "robot_1" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_group_file_quote_1",
          msgtype: "text",
          text: { content: "群聊文件", isReplyMsg: true },
          conversationType: "2",
          conversationId: "cid_group_1",
          senderId: "user_1",
          senderStaffId: "staff_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      expect(shared.resolveQuotedFileMock).toHaveBeenCalledTimes(1);
      const restored = messageContextStore.resolveByMsgId({
        storePath: STORE_PATH,
        accountId: "main",
        conversationId: "cid_group_1",
        msgId: "group_file_msg_1",
      });
      expect(restored).not.toBeNull();
      expect(restored!.media?.downloadCode).toBeUndefined();
      expect(restored!.media?.spaceId).toBe("space_group_1");
      expect(restored!.media?.fileId).toBe("dentry_group_1");
    });

    it("restores group quoted file using persisted metadata download context", async () => {
      const runtime = buildRuntime();
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      messageContextStore.clearMessageContextCacheForTest();
      messageContextStore.upsertInboundMessageContext({
        storePath: STORE_PATH,
        accountId: "main",
        conversationId: "cid_group_2",
        msgId: "file_origin",
        createdAt: Date.now(),
        messageType: "file",
        media: {
          spaceId: "space_group_2",
          fileId: "dentry_group_2",
        },
        ttlMs: messageContextStore.DEFAULT_MEDIA_CONTEXT_TTL_MS,
        topic: null,
      });
      messageContextStore.clearMessageContextCacheForTest();
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "群聊文件",
        messageType: "text",
        quoted: {
          isQuotedFile: true,
          msgId: "file_origin",
          fileCreatedAt: 1772863284581,
        },
      });
      shared.downloadGroupFileMock.mockResolvedValueOnce({
        path: "/tmp/.openclaw/media/inbound/group-file.bin",
        mimeType: "application/octet-stream",
      });

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown", clientId: "robot_1" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_group_file_quote_2",
          msgtype: "text",
          text: { content: "群聊文件", isReplyMsg: true },
          conversationType: "2",
          conversationId: "cid_group_2",
          senderId: "user_1",
          senderStaffId: "staff_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      expect(shared.getUnionIdByStaffIdMock).toHaveBeenCalledTimes(1);
      expect(shared.downloadGroupFileMock).toHaveBeenCalledWith(
        expect.anything(),
        "space_group_2",
        "dentry_group_2",
        "union_1",
        undefined,
        undefined,
      );
    });
  });

  describe("filename resolution for attachment extraction", () => {
    it("uses cached filename when stored attachmentFileName exists (cached resolution)", async () => {
      const runtime = buildRuntime();
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      messageContextStore.clearMessageContextCacheForTest();
      // Set up cached doc card with stored filename
      messageContextStore.upsertInboundMessageContext({
        storePath: STORE_PATH,
        accountId: "main",
        conversationId: "cid_dm_cached_doc_name",
        msgId: "doc_origin_msg_cached_name",
        createdAt: Date.now(),
        messageType: "interactiveCardFile",
        media: {
          spaceId: "space_doc_cached_name",
          fileId: "file_doc_cached_name",
        },
        attachmentFileName: "stored-manual.pdf",
        ttlMs: messageContextStore.DEFAULT_MEDIA_CONTEXT_TTL_MS,
        topic: null,
      });
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "继续看这个文档",
        messageType: "text",
        quoted: {
          isQuotedDocCard: true,
          msgId: "doc_origin_msg_cached_name",
          previewFileName: "preview-manual.tmp", // preview filename differs from stored
        },
      });
      shared.downloadGroupFileMock.mockResolvedValueOnce({
        path: "/tmp/.openclaw/media/inbound/doc-card-cached.bin",
        mimeType: "application/octet-stream",
      });
      shared.extractAttachmentTextMock.mockResolvedValueOnce({
        text: "摘录首段",
        sourceType: "pdf",
        truncated: false,
      });

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown", clientId: "robot_1" } as unknown as DingTalkConfig,
        data: {
          msgId: "doc_quote_msg_cached_filename",
          msgtype: "text",
          text: { content: "继续看这个文档", isReplyMsg: true },
          originalMsgId: "doc_origin_msg_cached_name",
          conversationType: "1",
          conversationId: "cid_dm_cached_doc_name",
          senderId: "user_1",
          senderStaffId: "staff_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      // Cached filename should be preferred over preview filename
      expect(shared.extractAttachmentTextMock).toHaveBeenCalledWith({
        path: "/tmp/.openclaw/media/inbound/doc-card-cached.bin",
        mimeType: "application/octet-stream",
        fileName: "stored-manual.pdf",
      });
    });

    it("uses resolved filename from API when no cached metadata exists (fallback resolution)", async () => {
      const runtime = buildRuntime();
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      messageContextStore.clearMessageContextCacheForTest();
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "群聊文件",
        messageType: "text",
        quoted: {
          isQuotedFile: true,
          msgId: "group_file_msg_name",
          fileCreatedAt: 1772863284581,
          previewFileName: "preview-name.tmp", // preview filename differs from resolved
        },
      });
      shared.resolveQuotedFileMock.mockResolvedValueOnce({
        media: {
          path: "/tmp/.openclaw/media/inbound/group-file.bin",
          mimeType: "application/octet-stream",
        },
        spaceId: "space_group_2",
        fileId: "dentry_group_2",
        name: "fallback-name.sql", // resolved filename
      });
      shared.extractAttachmentTextMock.mockResolvedValueOnce({
        text: "select * from t;",
        sourceType: "text",
        truncated: false,
      });

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { groupPolicy: "open", messageType: "markdown", clientId: "robot_1" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_group_file_name",
          msgtype: "text",
          text: { content: "群聊文件", isReplyMsg: true },
          conversationType: "2",
          conversationId: "cid_group_name",
          senderId: "user_1",
          senderStaffId: "staff_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      // Resolved filename should be preferred over preview filename
      expect(shared.extractAttachmentTextMock).toHaveBeenCalledWith({
        path: "/tmp/.openclaw/media/inbound/group-file.bin",
        mimeType: "application/octet-stream",
        fileName: "fallback-name.sql",
      });
      const restored = messageContextStore.resolveByMsgId({
        storePath: STORE_PATH,
        accountId: "main",
        conversationId: "cid_group_name",
        msgId: "group_file_msg_name",
      });
      expect(restored?.attachmentFileName).toBe("fallback-name.sql");
    });
  });
});
