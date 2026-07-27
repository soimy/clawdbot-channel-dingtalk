import { vi } from "vitest";

const shared = vi.hoisted(() => ({
  isBtwRequestTextMock: vi.fn(),
  isAbortRequestTextMock: vi.fn(),
  extractMessageContentMock: vi.fn(),
  getRuntimeMock: vi.fn(),
  sendBySessionMock: vi.fn(),
  sendMessageMock: vi.fn(),
  dispatchMock: vi.fn(),
  createAICardMock: vi.fn(),
  commitAICardBlocksMock: vi.fn(),
  finishAICardMock: vi.fn(),
  isCardInTerminalStateMock: vi.fn(),
  recallAICardMessageMock: vi.fn(),
  streamAICardMock: vi.fn(),
  formatContentForCardMock: vi.fn((s: string) => s),
  extractAttachmentTextMock: vi.fn(),
  prepareMediaInputMock: vi.fn(),
  resolveOutboundMediaTypeMock: vi.fn(),
  downloadGroupFileMock: vi.fn(),
  getUnionIdByStaffIdMock: vi.fn(),
  resolveQuotedFileMock: vi.fn(),
  sendProactiveMediaMock: vi.fn(),
  deliverBtwReplyMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  isAbortRequestText: shared.isAbortRequestTextMock,
  isBtwRequestText: shared.isBtwRequestTextMock,
}));

vi.mock("../../../src/messaging/btw-deliver", () => ({
  deliverBtwReply: shared.deliverBtwReplyMock,
  stripLeadingMentions: (text: string) => text.replace(/^(?:@\S+\s+)*/u, ""),
  buildBtwBlockquote: vi.fn(),
}));

vi.mock("../../../src/auth", () => ({
  getAccessToken: vi.fn().mockResolvedValue("token_abc"),
}));

vi.mock("../../../src/runtime", () => ({
  getDingTalkRuntime: shared.getRuntimeMock,
}));

vi.mock("../../../src/message-utils", () => ({
  extractMessageContent: shared.extractMessageContentMock,
}));

vi.mock("../../../src/messaging/attachment-text-extractor", () => ({
  extractAttachmentText: shared.extractAttachmentTextMock,
}));

vi.mock("../../../src/send-service", () => ({
  sendBySession: shared.sendBySessionMock,
  sendMessage: shared.sendMessageMock,
  sendProactiveMedia: shared.sendProactiveMediaMock,
}));

vi.mock("../../../src/media-utils", async () => {
  const actual =
    await vi.importActual<typeof import("../../../src/media-utils")>("../../../src/media-utils");
  return {
    ...actual,
    prepareMediaInput: shared.prepareMediaInputMock,
    resolveOutboundMediaType: shared.resolveOutboundMediaTypeMock,
  };
});

vi.mock("../../../src/card-service", () => ({
  createAICard: shared.createAICardMock,
  commitAICardBlocks: shared.commitAICardBlocksMock,
  finishAICard: shared.finishAICardMock,
  formatContentForCard: shared.formatContentForCardMock,
  isCardInTerminalState: shared.isCardInTerminalStateMock,
  recallAICardMessage: shared.recallAICardMessageMock,
  streamAICard: shared.streamAICardMock,
}));

vi.mock("../../../src/message-context-store", async () => {
  const actual = await vi.importActual<typeof import("../../../src/message-context-store")>(
    "../../../src/message-context-store",
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

vi.mock("../../../src/messaging/quoted-file-service", () => ({
  downloadGroupFile: shared.downloadGroupFileMock,
  getUnionIdByStaffId: shared.getUnionIdByStaffIdMock,
  resolveQuotedFile: shared.resolveQuotedFileMock,
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearCardRunRegistryForTest } from "../../../src/card/card-run-registry";
// NOTE: inbound-session-queue, session-lock, and reply-session-conflict are NOT
// mocked — we exercise the real promise-chain serializer + real per-session lock.
import { handleDingTalkMessage } from "../../../src/inbound-handler";
import { resetProactivePermissionHintStateForTest } from "../../../src/inbound-handler";
import {
  chainInboundSessionTask,
  MAX_INBOUND_SESSION_QUEUE_DEPTH,
  MAX_INBOUND_SESSION_QUEUE_WAIT_MS,
  QUEUE_BUSY_ACK_PHRASES,
  resetInboundSessionQueueForTest,
} from "../../../src/gateway/inbound-session-queue";
import { dispatchInboundViaSessionQueue } from "../../../src/gateway/inbound-session-queue-dispatcher";
import * as messageContextStore from "../../../src/message-context-store";
import { clearTargetDirectoryStateCache } from "../../../src/targeting/target-directory-store";

const TEST_TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-queue-int-"));
export const STORE_PATH = path.join(TEST_TMP_DIR, "store-queue.json");
export const SESSION_KEY = "agent:main:dingtalk:direct:user-queue";

function buildRuntime() {
  return {
    channel: {
      routing: {
        resolveAgentRoute: vi.fn().mockReturnValue({
          agentId: "main",
          sessionKey: SESSION_KEY,
          mainSessionKey: SESSION_KEY,
        }),
        buildAgentSessionKey: vi.fn().mockReturnValue("agent-session-key"),
      },
      media: {
        saveMediaBuffer: vi
          .fn()
          .mockResolvedValue({ path: "/tmp/m.png", contentType: "image/png" }),
      },
      session: {
        resolveStorePath: vi.fn().mockReturnValue(STORE_PATH),
        readSessionUpdatedAt: vi.fn().mockReturnValue(null),
        recordInboundSession: vi.fn().mockResolvedValue(undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
        formatInboundEnvelope: vi.fn().mockReturnValue("body"),
        finalizeInboundContext: vi.fn().mockReturnValue({ SessionKey: SESSION_KEY }),
        dispatchReplyWithBufferedBlockDispatcher: shared.dispatchMock,
      },
    },
  };
}

export const cardSerial = { value: 0 };
export function buildMessage(text: string, msgId: string) {
  return {
    cfg: {},
    accountId: "main",
    inboundOrigin: "stream",
    inboundQueueEligible: true,
    sessionWebhook: `https://session.webhook/${msgId}`,
    log: undefined,
    dingtalkConfig: { dmPolicy: "open", clientId: "robot_x", messageType: "card" } as any,
    data: {
      msgId,
      msgtype: "text",
      text: { content: text },
      conversationType: "1",
      conversationId: "cid_queue_1",
      senderId: "user-queue",
      senderNick: "排队用户",
      chatbotUserId: "bot_1",
      sessionWebhook: `https://session.webhook/${msgId}`,
      createAt: Date.now(),
    },
  } as any;
}

// Real stream messages now enter the queue inside handleDingTalkMessage, after
// access control and route.sessionKey resolution. Gateway only invokes handler.
export function dispatch(msg: any): Promise<void> {
  return handleDingTalkMessage(msg);
}

export function queueInput(msg: any) {
  return {
    accountId: msg.accountId,
    data: msg.data,
    dingtalkConfig: msg.dingtalkConfig,
    sessionKey: SESSION_KEY,
    to: msg.data.senderId,
    storePath: STORE_PATH,
    quoteContent: msg.data.text.content,
    log: msg.log,
  };
}


export function resetInboundSessionQueueIntegrationTest(): void {
    clearTargetDirectoryStateCache();
    fs.rmSync(path.join(TEST_TMP_DIR, "dingtalk-state"), { recursive: true, force: true });

    shared.sendBySessionMock.mockReset();
    shared.sendBySessionMock.mockResolvedValue({ ok: true });
    shared.sendMessageMock.mockReset();
    shared.sendMessageMock.mockResolvedValue({ ok: true });
    shared.dispatchMock.mockReset();
    shared.extractMessageContentMock.mockReset();
    shared.isAbortRequestTextMock.mockReset();
    shared.isAbortRequestTextMock.mockReturnValue(false);
    shared.isBtwRequestTextMock.mockReset();
    shared.isBtwRequestTextMock.mockReturnValue(false);
    shared.createAICardMock.mockReset();
    shared.commitAICardBlocksMock.mockReset();
    shared.commitAICardBlocksMock.mockResolvedValue(undefined);
    shared.finishAICardMock.mockReset();
    shared.finishAICardMock.mockResolvedValue(undefined);
    shared.isCardInTerminalStateMock.mockReset();
    shared.recallAICardMessageMock.mockReset();
    shared.recallAICardMessageMock.mockResolvedValue(true);
    shared.streamAICardMock.mockReset();
    shared.streamAICardMock.mockResolvedValue(undefined);
    shared.extractAttachmentTextMock.mockReset();
    shared.extractAttachmentTextMock.mockResolvedValue(null);
    shared.prepareMediaInputMock.mockReset();
    shared.resolveOutboundMediaTypeMock.mockReset();
    shared.resolveOutboundMediaTypeMock.mockReturnValue("file");
    shared.downloadGroupFileMock.mockReset();
    shared.downloadGroupFileMock.mockResolvedValue(null);
    shared.getUnionIdByStaffIdMock.mockReset();
    shared.getUnionIdByStaffIdMock.mockResolvedValue("union_1");
    shared.resolveQuotedFileMock.mockReset();
    shared.resolveQuotedFileMock.mockResolvedValue(null);
    shared.sendProactiveMediaMock.mockReset();
    shared.deliverBtwReplyMock.mockReset();
    shared.deliverBtwReplyMock.mockResolvedValue(undefined);
    shared.getRuntimeMock.mockReturnValue(buildRuntime());
    resetProactivePermissionHintStateForTest();
    clearCardRunRegistryForTest();
    messageContextStore.clearMessageContextCacheForTest();
    resetInboundSessionQueueForTest();
    cardSerial.value = 0;
}

export function cleanupInboundSessionQueueIntegrationTest(): void {
  resetInboundSessionQueueForTest();
  vi.useRealTimers();
}

export { shared };
