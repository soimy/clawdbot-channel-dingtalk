import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DingTalkConfig } from "../../src/types";

const shared = vi.hoisted(() => ({
  getRuntimeMock: vi.fn(),
  extractMessageContentMock: vi.fn(),
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
}));

vi.mock("../../src/runtime", () => ({
  getDingTalkRuntime: shared.getRuntimeMock,
}));

vi.mock("../../src/message-utils", () => ({
  extractMessageContent: shared.extractMessageContentMock,
}));

vi.mock("../../src/messaging/attachment-text-extractor", () => ({
  extractAttachmentText: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/messaging/quoted-file-service", () => ({
  downloadGroupFile: vi.fn().mockResolvedValue(null),
  getUnionIdByStaffId: vi.fn().mockResolvedValue("union_1"),
  resolveQuotedFile: vi.fn().mockResolvedValue(null),
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
import { clearTargetDirectoryStateCache } from "../../src/targeting/target-directory-store";

const mockedUpsertInboundMessageContext = vi.mocked(messageContextStore.upsertInboundMessageContext);
const TEST_TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-card-streaming-unit-"));
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

describe("inbound-handler card streaming", () => {
  beforeEach(() => {
    clearTargetDirectoryStateCache();
    const stateDir = path.join(TEST_TMP_DIR, "dingtalk-state");
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOTEMPTY") {
        fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
    shared.getRuntimeMock.mockReset();
    shared.extractMessageContentMock.mockReset();
    shared.extractMessageContentMock.mockReturnValue({ text: "hello", messageType: "text" });
    shared.createAICardMock.mockReset();
    shared.createAICardMock.mockResolvedValue({
      cardInstanceId: "card_1",
      state: "1",
      lastUpdated: Date.now(),
    });
    shared.sendMessageMock.mockReset();
    shared.sendMessageMock.mockImplementation(
      async (
        _config: unknown,
        _to: unknown,
        text: unknown,
        options: { card?: { lastStreamedContent?: unknown }; cardUpdateMode?: string },
      ) => {
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
    shared.isCardInTerminalStateMock.mockReturnValue(false);
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

    shared.getRuntimeMock.mockReturnValue(buildRuntime());
    resetProactivePermissionHintStateForTest();
    clearCardRunRegistryForTest();
    messageContextStore.clearMessageContextCacheForTest();
  });

  describe("updateAICardBlockList streaming", () => {
    it("streams reasoning updates to card via controller (updateAICardBlockList)", async () => {
      const runtime = buildRuntime();
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
        .fn()
        .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions?.onReasoningStream?.({ text: "thinking pass 1" });
          await dispatcherOptions.deliver({ text: "done" }, { kind: "final" });
          return { queuedFinal: false };
        });
      shared.getRuntimeMock.mockReturnValueOnce(runtime);

      const card = {
        cardInstanceId: "card_reasoning_replace",
        state: "1",
        lastUpdated: Date.now(),
      } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
      shared.createAICardMock.mockResolvedValueOnce(card);
      shared.isCardInTerminalStateMock.mockReturnValue(false);

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          dmPolicy: "open",
          messageType: "card",
          ackReaction: "",
          cardRealTimeStream: true,
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m_reasoning_replace",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      // PR#494: cardRealTimeStream=true maps to mode="all", which uses updateAICardBlockList
      // for reasoning updates (not streamAICard which is only used in finishAICard)
      expect(shared.updateAICardBlockListMock).toHaveBeenCalled();
      const lastCall = shared.updateAICardBlockListMock.mock.calls.at(-1);
      expect(lastCall).toBeTruthy();
      expect(lastCall?.[0]?.cardInstanceId).toBe("card_reasoning_replace");
    });

    it("handleDingTalkMessage group card flow creates card and streams tool/reasoning", async () => {
      const runtime = buildRuntime();
      shared.getRuntimeMock.mockReturnValueOnce(runtime);

      const createdCard = {
        cardInstanceId: "card_new",
        state: "1",
        lastUpdated: Date.now(),
      } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
      shared.createAICardMock.mockResolvedValueOnce(createdCard);
      shared.isCardInTerminalStateMock.mockReturnValue(false);
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "group hello",
        mediaPath: "download_code_1",
        messageType: "text",
      });

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          groupPolicy: "allowlist",
          allowFrom: ["cid_group_1"],
          messageType: "card",
          clientId: "robot_1",
          groups: { cid_group_1: { systemPrompt: "group prompt" } },
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m8",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "2",
          conversationId: "cid_group_1",
          conversationTitle: "group-title",
          senderId: "user_1",
          senderNick: "Alice",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      expect(shared.createAICardMock).toHaveBeenCalledTimes(1);
      expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
    });

    it("updates the same card with sanitized runtime task progress before the final answer", async () => {
      const runtime = buildRuntime() as ReturnType<typeof buildRuntime> & {
        events: { onAgentEvent: (listener: (event: unknown) => void) => () => void };
      };
      let agentEventListener: ((event: unknown) => void) | undefined;
      runtime.events = {
        onAgentEvent: vi.fn((listener) => {
          agentEventListener = listener;
          return vi.fn();
        }),
      };
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
        .fn()
        .mockImplementation(async ({ dispatcherOptions }) => {
          agentEventListener?.({
            stream: "lifecycle",
            runId: "run-progress",
            sessionKey: "s1",
            data: { phase: "start" },
          });
          agentEventListener?.({
            stream: "tool",
            runId: "run-progress",
            sessionKey: "s1",
            data: {
              phase: "start",
              name: "exec",
              toolCallId: "tool-progress",
              args: { cmd: "curl -H 'Authorization: secret-token' https://example.com" },
            },
          });
          await Promise.resolve();
          await Promise.resolve();
          await dispatcherOptions.deliver({ text: "完成" }, { kind: "final" });
          return { queuedFinal: false };
        });
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      shared.createAICardMock.mockResolvedValueOnce({
        cardInstanceId: "card_progress",
        state: "1",
        lastUpdated: Date.now(),
      });

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          dmPolicy: "open",
          messageType: "card",
          ackReaction: "",
          cardStreamingMode: "answer",
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m_progress",
          msgtype: "text",
          text: { content: "执行一个长任务" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      const progressFrames = shared.updateAICardBlockListMock.mock.calls
        .map((call) => String(call[1] ?? ""))
        .filter((frame) => frame.includes("任务处理中"));
      expect(progressFrames).not.toHaveLength(0);
      expect(progressFrames.at(-1)).toContain("当前阶段：正在执行检查");
      expect(progressFrames.at(-1)).not.toContain("secret-token");
      expect(shared.commitAICardBlocksMock.mock.calls.at(-1)?.[1]?.content).toContain("完成");
    });
  });

  describe("reasoning buffer assembly and flush", () => {
    it("buffers reasoning stream snapshots and flushes complete block on final answer", async () => {
      const runtime = buildRuntime();
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
        .fn()
        .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
          // Simulate incremental reasoning stream (incomplete block)
          await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_Reason: 先检查" });
          // Simulate complete reasoning block (sealed)
          await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_Reason: 先检查当前目录_" });
          // Final answer triggers flush
          await dispatcherOptions.deliver({ text: "最终答案" }, { kind: "final" });
          return { queuedFinal: false };
        });
      shared.getRuntimeMock.mockReturnValueOnce(runtime);

      const card = {
        cardInstanceId: "card_reasoning_buffer_flush",
        state: "1",
        lastUpdated: Date.now(),
      } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
      shared.createAICardMock.mockResolvedValueOnce(card);
      shared.isCardInTerminalStateMock.mockReturnValue(false);

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          dmPolicy: "open",
          messageType: "card",
          ackReaction: "",
          cardStreamingMode: "answer",
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m_reasoning_buffer_flush",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      // PR#494 + V2: reasoning streams in "answer" mode go through blockList updates
      expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
      const blockListJson =
        shared.commitAICardBlocksMock.mock.calls.at(-1)?.[1]?.blockListJson ?? "";
      // Only the sealed reasoning block should be in blockList
      expect(blockListJson).toContain("先检查当前目录");
      // Final answer should be in content
      const content = shared.commitAICardBlocksMock.mock.calls.at(-1)?.[1]?.content ?? "";
      expect(content).toContain("最终答案");
      // Incomplete reasoning should not appear
      expect(content).not.toContain("Reason:");
    });

    it("flushes pending reasoning and resets assembly across assistant turns", async () => {
      const runtime = buildRuntime();
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
        .fn()
        .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
          // First turn: incomplete reasoning
          await replyOptions?.onReasoningStream?.({
            text: "Reasoning:\n_Reason: 第一轮未封口",
          });
          // Assistant turn marker resets the buffer
          await replyOptions?.onAssistantMessageStart?.();
          // Second turn: new sealed reasoning
          await replyOptions?.onReasoningStream?.({
            text: "Reasoning:\n_Reason: 第二轮新思考_",
          });
          // Final answer
          await dispatcherOptions.deliver({ text: "最终答案" }, { kind: "final" });
          return { queuedFinal: false };
        });
      shared.getRuntimeMock.mockReturnValueOnce(runtime);

      const card = {
        cardInstanceId: "card_reasoning_multi_turn",
        state: "1",
        lastUpdated: Date.now(),
      } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
      shared.createAICardMock.mockResolvedValueOnce(card);
      shared.isCardInTerminalStateMock.mockReturnValue(false);

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          dmPolicy: "open",
          messageType: "card",
          ackReaction: "",
          cardStreamingMode: "answer",
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m_reasoning_multi_turn",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
      const finalContent = shared.commitAICardBlocksMock.mock.calls[0][1]?.content;
      // Only answer text is included, reasoning blocks are excluded
      expect(finalContent).toContain("最终答案");
      expect(finalContent).not.toContain("Reason: 第一轮未封口");
      expect(finalContent).not.toContain("Reason: 第二轮新思考");
    });
  });

  describe("reasoning-on session block handling", () => {
    it("card flow renders reasoning-on blocks before the final answer", async () => {
      const runtime = buildRuntime();
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
        .fn()
        .mockImplementation(async ({ dispatcherOptions }) => {
          await dispatcherOptions.deliver(
            { text: "Reasoning:\n_Reason: 先检查当前目录_", isReasoning: true },
            { kind: "block" },
          );
          await dispatcherOptions.deliver({ text: "最终答案" }, { kind: "final" });
          return { queuedFinal: false };
        });
      shared.getRuntimeMock.mockReturnValueOnce(runtime);

      const card = {
        cardInstanceId: "card_reasoning_on_block",
        state: "1",
        lastUpdated: Date.now(),
      } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
      shared.createAICardMock.mockResolvedValueOnce(card);
      shared.isCardInTerminalStateMock.mockReturnValue(false);

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          dmPolicy: "open",
          messageType: "card",
          ackReaction: "",
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m_reasoning_on_block",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
      const finalContent = shared.commitAICardBlocksMock.mock.calls[0][1]?.content;
      // Only answer text is included, reasoning blocks are excluded
      expect(finalContent).toContain("最终答案");
      expect(finalContent).not.toContain("Reason: 先检查当前目录");
    });

    it("card flow enables block streaming for reasoning-on sessions so runtime can emit reasoning blocks", async () => {
      const runtime = buildRuntime();
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
        .fn()
        .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
          expect(replyOptions?.disableBlockStreaming).toBe(false);
          if (replyOptions?.disableBlockStreaming) {
            await dispatcherOptions.deliver({ text: "最终答案" }, { kind: "final" });
          } else {
            await dispatcherOptions.deliver(
              { text: "Reasoning:\n_Reason: 先检查当前目录_", isReasoning: true },
              { kind: "block" },
            );
            await dispatcherOptions.deliver({ text: "最终答案" }, { kind: "final" });
          }
          return { queuedFinal: false };
        });
      runtime.channel.session.resolveStorePath = vi
        .fn()
        .mockReturnValueOnce("/tmp/account-store-card-reasoning-on.json")
        .mockReturnValueOnce("/tmp/agent-store-card-reasoning-on.json");
      runtime.channel.session.readSessionUpdatedAt = vi.fn().mockReturnValue(1234567890);
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      fs.writeFileSync(
        "/tmp/agent-store-card-reasoning-on.json",
        JSON.stringify({
          s1: {
            sessionId: "session-card-1",
            updatedAt: 1234567890,
            reasoningLevel: "on",
          },
        }),
      );

      const card = {
        cardInstanceId: "card_reasoning_on_session_gate",
        state: "1",
        lastUpdated: Date.now(),
      } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
      shared.createAICardMock.mockResolvedValueOnce(card);
      shared.isCardInTerminalStateMock.mockReturnValue(false);

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          dmPolicy: "open",
          messageType: "card",
          ackReaction: "",
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m_card_reasoning_on_gate",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
      const finalContent =
        shared.commitAICardBlocksMock.mock.calls.at(-1)?.[1]?.content ?? "";
      // Only answer text is included, reasoning blocks are excluded
      expect(finalContent).toContain("最终答案");
      expect(finalContent).not.toContain("Reason: 先检查当前目录");
    });

    it("card flow keeps answer text when reasoning-on sessions deliver answer blocks without a final payload", async () => {
      const runtime = buildRuntime();
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
        .fn()
        .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
          expect(replyOptions?.disableBlockStreaming).toBe(false);
          await dispatcherOptions.deliver({ text: "最终答案" }, { kind: "block" });
          return { queuedFinal: false };
        });
      runtime.channel.session.resolveStorePath = vi
        .fn()
        .mockReturnValueOnce("/tmp/account-store-card-answer-block.json")
        .mockReturnValueOnce("/tmp/agent-store-card-answer-block.json");
      runtime.channel.session.readSessionUpdatedAt = vi.fn().mockReturnValue(1234567890);
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      fs.writeFileSync(
        "/tmp/agent-store-card-answer-block.json",
        JSON.stringify({
          s1: {
            sessionId: "session-card-answer-block",
            updatedAt: 1234567890,
            reasoningLevel: "on",
          },
        }),
      );

      const card = {
        cardInstanceId: "card_reasoning_on_answer_block",
        state: "1",
        lastUpdated: Date.now(),
      } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
      shared.createAICardMock.mockResolvedValueOnce(card);
      shared.isCardInTerminalStateMock.mockReturnValue(false);

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          dmPolicy: "open",
          messageType: "card",
          ackReaction: "",
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m_card_reasoning_on_answer_block",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
      const finalContent =
        shared.commitAICardBlocksMock.mock.calls.at(-1)?.[1]?.content ?? "";
      expect(finalContent).toContain("最终答案");
      expect(finalContent).not.toContain("Done");
    });

    it("card flow recovers thinking and answer from mixed reasoning-on block text without explicit metadata", async () => {
      const runtime = buildRuntime();
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
        .fn()
        .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
          expect(replyOptions?.disableBlockStreaming).toBe(false);
          await dispatcherOptions.deliver(
            {
              text: "Reasoning:\n_Reason: 先检查当前目录_\n\n最终答案：/tmp",
            },
            { kind: "block" },
          );
          await dispatcherOptions.deliver({ text: "" }, { kind: "final" });
          return { queuedFinal: false };
        });
      runtime.channel.session.resolveStorePath = vi
        .fn()
        .mockReturnValueOnce("/tmp/account-store-card-mixed-reasoning.json")
        .mockReturnValueOnce("/tmp/agent-store-card-mixed-reasoning.json");
      runtime.channel.session.readSessionUpdatedAt = vi.fn().mockReturnValue(1234567890);
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      fs.writeFileSync(
        "/tmp/agent-store-card-mixed-reasoning.json",
        JSON.stringify({
          s1: {
            sessionId: "session-card-mixed-reasoning",
            updatedAt: 1234567890,
            reasoningLevel: "on",
          },
        }),
      );

      const card = {
        cardInstanceId: "card_reasoning_on_mixed_block",
        state: "1",
        lastUpdated: Date.now(),
      } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
      shared.createAICardMock.mockResolvedValueOnce(card);
      shared.isCardInTerminalStateMock.mockReturnValue(false);

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          dmPolicy: "open",
          messageType: "card",
          ackReaction: "",
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m_card_reasoning_on_mixed_block",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
      const blockListJson =
        shared.commitAICardBlocksMock.mock.calls.at(-1)?.[1]?.blockListJson ?? "";
      expect(blockListJson).toContain("先检查当前目录");
      expect(blockListJson).toContain("最终答案：/tmp");
    });

    it("card flow recovers thinking and answer from mixed reasoning-on partial snapshots", async () => {
      const runtime = buildRuntime();
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
        .fn()
        .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
          expect(replyOptions?.disableBlockStreaming).toBe(false);
          await replyOptions?.onPartialReply?.({
            text: "Reasoning:\n_Reason: 先检查当前目录_\n\n最终答案：/tmp",
          });
          await dispatcherOptions.deliver({ text: "" }, { kind: "final" });
          return { queuedFinal: false };
        });
      runtime.channel.session.resolveStorePath = vi
        .fn()
        .mockReturnValueOnce("/tmp/account-store-card-mixed-reasoning-partial.json")
        .mockReturnValueOnce("/tmp/agent-store-card-mixed-reasoning-partial.json");
      runtime.channel.session.readSessionUpdatedAt = vi.fn().mockReturnValue(1234567890);
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      fs.writeFileSync(
        "/tmp/agent-store-card-mixed-reasoning-partial.json",
        JSON.stringify({
          s1: {
            sessionId: "session-card-mixed-reasoning-partial",
            updatedAt: 1234567890,
            reasoningLevel: "on",
          },
        }),
      );

      const card = {
        cardInstanceId: "card_reasoning_on_mixed_partial",
        state: "1",
        lastUpdated: Date.now(),
      } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
      shared.createAICardMock.mockResolvedValueOnce(card);
      shared.isCardInTerminalStateMock.mockReturnValue(false);

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          dmPolicy: "open",
          messageType: "card",
          ackReaction: "",
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m_card_reasoning_on_mixed_partial",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
      const commitPayload = shared.commitAICardBlocksMock.mock.calls.at(-1)?.[1];
      expect(commitPayload?.blockListJson ?? "").toContain("先检查当前目录");
      expect(commitPayload?.blockListJson ?? "").toContain("最终答案：/tmp");
      expect(commitPayload?.content ?? "").toContain("最终答案：/tmp");
      expect(commitPayload?.content ?? "").not.toContain("Reason: 先检查当前目录");
    });
  });

  describe("late block and tool handling", () => {
    it("card flow ignores late partial snapshots but still absorbs late answer blocks/finals after final", async () => {
      const runtime = buildRuntime();
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
        .fn()
        .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions?.onPartialReply?.({ text: "阶段性答案" });
          await dispatcherOptions.deliver({ text: "首个最终答案" }, { kind: "final" });
          await replyOptions?.onPartialReply?.({ text: "晚到 partial 覆盖答案（应忽略）" });
          await dispatcherOptions.deliver(
            { text: "晚到 block 覆盖答案（应吸收）\n\nReasoning:\n_Reason: final 后补齐推理_" },
            { kind: "block" },
          );
          await dispatcherOptions.deliver({ text: "late tool output" }, { kind: "tool" });
          await dispatcherOptions.deliver({ text: "晚到 final 覆盖答案（应吸收）" }, { kind: "final" });
          return { queuedFinal: false };
        });
      shared.getRuntimeMock.mockReturnValueOnce(runtime);

      const card = {
        cardInstanceId: "card_late_after_final",
        state: "1",
        lastUpdated: Date.now(),
      } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
      shared.createAICardMock.mockResolvedValueOnce(card);
      shared.isCardInTerminalStateMock.mockReturnValue(false);

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          dmPolicy: "open",
          messageType: "card",
          ackReaction: "",
          cardStreamingMode: "answer",
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m_card_late_after_final",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      // PR#494 + V2: uses commitAICardBlocks for finalize
      expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
      const blockListJson =
        shared.commitAICardBlocksMock.mock.calls.at(-1)?.[1]?.blockListJson ?? "";
      const content = shared.commitAICardBlocksMock.mock.calls.at(-1)?.[1]?.content ?? "";
      // The last final overwrites earlier ones
      expect(content).toContain("晚到 final 覆盖答案");
      expect(content).not.toContain("首个最终答案");
      // Tool output should be in the block list
      expect(blockListJson).toContain("late tool output");
    });

    it.each(["off", "answer"] as const)(
      "card flow preserves a normal final when a later error final arrives in %s mode",
      async (cardStreamingMode) => {
        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
          .fn()
          .mockImplementation(async ({ dispatcherOptions }) => {
            await dispatcherOptions.deliver({ text: "正常最终答案" }, { kind: "final" });
            await dispatcherOptions.deliver(
              { text: "⚠️ 🛠️ Exec failed: ledger", isError: true },
              { kind: "final" },
            );
            return { queuedFinal: false };
          });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        const card = {
          cardInstanceId: "card_error_final_after_answer",
          state: "1",
          lastUpdated: Date.now(),
        } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
        shared.createAICardMock.mockResolvedValueOnce(card);
        shared.isCardInTerminalStateMock.mockReturnValue(false);

        await handleDingTalkMessage({
          cfg: {},
          accountId: "main",
          sessionWebhook: "https://session.webhook",
          log: undefined,
          dingtalkConfig: {
            dmPolicy: "open",
            messageType: "card",
            ackReaction: "",
            cardStreamingMode,
          } as unknown as DingTalkConfig,
          data: {
            msgId: "m_card_error_final_after_answer",
            msgtype: "text",
            text: { content: "hello" },
            conversationType: "1",
            conversationId: "cid_ok",
            senderId: "user_1",
            chatbotUserId: "bot_1",
            sessionWebhook: "https://session.webhook",
            createAt: Date.now(),
          },
        } as unknown as { data: unknown });

        const content = shared.commitAICardBlocksMock.mock.calls.at(-1)?.[1]?.content ?? "";
        expect(content).toContain("正常最终答案");
        expect(content).not.toContain("Exec failed");
      },
    );

    it("card flow inserts late tool before frozen final answer when the answer turn was sealed before first final", async () => {
      const runtime = buildRuntime();
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
        .fn()
        .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions?.onPartialReply?.({ text: "阶段性答案（将被冻结答案覆盖）" });
          await replyOptions?.onAssistantMessageStart?.();
          await dispatcherOptions.deliver({ text: "首个最终答案" }, { kind: "final" });
          await dispatcherOptions.deliver({ text: "late sealed-case tool output" }, { kind: "tool" });
          return { queuedFinal: false };
        });
      shared.getRuntimeMock.mockReturnValueOnce(runtime);

      const card = {
        cardInstanceId: "card_late_tool_before_sealed_answer",
        state: "1",
        lastUpdated: Date.now(),
      } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
      shared.createAICardMock.mockResolvedValueOnce(card);
      shared.isCardInTerminalStateMock.mockReturnValue(false);

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          dmPolicy: "open",
          messageType: "card",
          ackReaction: "",
          cardStreamingMode: "answer",
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m_card_late_tool_before_sealed_answer",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      // PR#494 + V2: uses commitAICardBlocks for finalize
      expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
      const blockListJson =
        shared.commitAICardBlocksMock.mock.calls.at(-1)?.[1]?.blockListJson ?? "";
      expect(blockListJson).toContain("首个最终答案");
      expect(blockListJson).toContain("late sealed-case tool output");
    });
  });

  describe("concurrent message streaming", () => {
    it("concurrent messages: second message falls back to markdown while first card is streaming", async () => {
      let resolveA!: () => void;
      const gateA = new Promise<void>((r) => {
        resolveA = r;
      });

      const cardA = {
        cardInstanceId: "card_A",
        state: "1",
        lastUpdated: Date.now(),
      } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
      shared.createAICardMock.mockResolvedValueOnce(cardA);
      shared.isCardInTerminalStateMock.mockReturnValue(false);

      const runtimeA = buildRuntime();
      runtimeA.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
        .fn()
        .mockImplementation(async ({ dispatcherOptions }) => {
          await gateA;
          await dispatcherOptions.deliver({ text: "tool A" }, { kind: "tool" });
          await dispatcherOptions.deliver({ text: "reply A" }, { kind: "final" });
          return { queuedFinal: "reply A" };
        });
      const runtimeB = buildRuntime();
      runtimeB.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
        .fn()
        .mockImplementation(async ({ dispatcherOptions }) => {
          await dispatcherOptions.deliver({ text: "reply B markdown" }, { kind: "final" });
          return { queuedFinal: "reply B markdown" };
        });
      shared.getRuntimeMock.mockReturnValueOnce(runtimeA).mockReturnValueOnce(runtimeB);

      const baseParams = {
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          dmPolicy: "open",
          messageType: "card",
          ackReaction: "",
        } as unknown as DingTalkConfig,
      };

      const promiseA = handleDingTalkMessage({
        ...baseParams,
        data: {
          msgId: "bind_A",
          msgtype: "text",
          text: { content: "hello A" },
          conversationType: "1",
          conversationId: "cid_same",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown; dingtalkConfig: unknown });

      // Wait for card_A creation to complete before starting message B.
      await vi.waitFor(() => {
        expect(shared.createAICardMock).toHaveBeenCalledTimes(1);
      });

      const promiseB = handleDingTalkMessage({
        ...baseParams,
        data: {
          msgId: "bind_B",
          msgtype: "text",
          text: { content: "hello B" },
          conversationType: "1",
          conversationId: "cid_same",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown; dingtalkConfig: unknown });

      await promiseB;
      resolveA();
      await promiseA;

      // Only one card should be created — second message falls back to markdown.
      expect(shared.createAICardMock).toHaveBeenCalledTimes(1);
      // Tool streaming should be bound to card_A only.
      const blockListCalls = shared.updateAICardBlockListMock.mock.calls;
      const toolCallA = blockListCalls.find(
        (call: unknown[]) => JSON.stringify(call[1] ?? "").includes("tool A"),
      );
      expect(toolCallA).toBeTruthy();
      expect(toolCallA?.[0]?.cardInstanceId).toBe("card_A");
    });
  });

  describe("card failure during streaming", () => {
    it("sends markdown fallback in post-dispatch when card fails mid-stream", async () => {
      const card = {
        cardInstanceId: "card_mid_fail",
        state: "1",
        lastUpdated: Date.now(),
      } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
      shared.createAICardMock.mockResolvedValueOnce(card);
      shared.isCardInTerminalStateMock.mockImplementation(
        (state: string) => state === "3" || state === "5",
      );

      // PR#494 + V2: updateAICardBlockList is used for block streaming
      // When it fails, the card controller marks the card as failed
      shared.updateAICardBlockListMock.mockImplementation(async () => {
        throw new Error("block list api error");
      });

      const log = {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
      };

      const runtime = buildRuntime();
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
        .fn()
        .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
          replyOptions?.onPartialReply?.({ text: "partial content" });
          await dispatcherOptions.deliver({ text: "tool output before failure" }, { kind: "tool" });
          await new Promise((r) => setTimeout(r, 350));
          await dispatcherOptions.deliver({ text: "complete final answer" }, { kind: "final" });
          return { queuedFinal: "complete final answer" };
        });
      shared.getRuntimeMock.mockReturnValueOnce(runtime);

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: log as unknown as {
          debug: unknown;
          warn: unknown;
          error: unknown;
          info: unknown;
        },
        dingtalkConfig: {
          dmPolicy: "open",
          messageType: "card",
          cardRealTimeStream: true,
        } as unknown as DingTalkConfig,
        data: {
          msgId: "mid_fail_test",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown });

      const debugLogs = log.debug.mock.calls.map((args: unknown[]) => String(args[0]));
      expect(
        debugLogs.some((msg) =>
          msg.includes("Card failed during streaming, sending markdown fallback"),
        ),
      ).toBe(true);

      // Fallback uses sendMessage with forceMarkdown to skip card creation
      // while preserving journal writes.
      const fallbackCalls = shared.sendMessageMock.mock.calls.filter(
        (call: unknown[]) => call[3]?.forceMarkdown === true,
      );
      expect(fallbackCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});
