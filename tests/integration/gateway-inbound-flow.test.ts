import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  connectMock: vi.fn(),
  waitForStopMock: vi.fn(),
  stopMock: vi.fn(),
  isConnectedMock: vi.fn(),
  listeners: {} as Record<string, (res: any) => Promise<void>>,
  socketCallBackResponseMock: vi.fn(),
  isMessageProcessedMock: vi.fn(),
  markMessageProcessedMock: vi.fn(),
  handleDingTalkMessageMock: vi.fn(),
  sendProactiveTextMock: vi.fn(),
  connectionConfig: undefined as any,
}));

vi.mock("openclaw/plugin-sdk/core", () => ({
  buildChannelConfigSchema: vi.fn((schema: unknown) => schema),
}));

vi.mock("dingtalk-stream", () => ({
  TOPIC_CARD: "TOPIC_CARD",
  TOPIC_ROBOT: "TOPIC_ROBOT",
  DWClient: class {
    config: Record<string, unknown>;
    registerCallbackListener: (topic: string, cb: (res: any) => Promise<void>) => void;
    socketCallBackResponse: (messageId: string, payload: unknown) => void;

    constructor() {
      this.config = {};
      this.registerCallbackListener = vi.fn((_topic: string, cb: (res: any) => Promise<void>) => {
        shared.listeners[_topic] = cb;
      });
      this.socketCallBackResponse = shared.socketCallBackResponseMock;
    }
  },
}));

vi.mock("../../src/connection-manager", () => ({
  ConnectionManager: class {
    connect: () => Promise<void>;
    waitForStop: () => Promise<void>;
    stop: () => void;
    isConnected: () => boolean;

    constructor(_client: unknown, _accountId: string, config: unknown) {
      shared.connectionConfig = config;
      this.connect = shared.connectMock;
      this.waitForStop = shared.waitForStopMock;
      this.stop = shared.stopMock;
      this.isConnected = shared.isConnectedMock;
    }
  },
}));

vi.mock("../../src/dedup", () => ({
  isMessageProcessed: shared.isMessageProcessedMock,
  markMessageProcessed: shared.markMessageProcessedMock,
}));

vi.mock("../../src/inbound-handler", () => ({
  handleDingTalkMessage: shared.handleDingTalkMessageMock,
}));

vi.mock("../../src/send-service", () => ({
  sendMessage: vi.fn(),
  sendProactiveMedia: vi.fn(),
  sendProactiveTextOrMarkdown: shared.sendProactiveTextMock,
  sendBySession: vi.fn(),
  uploadMedia: vi.fn(),
}));

import { CHANNEL_INFLIGHT_NAMESPACE_POLICY, dingtalkPlugin } from "../../src/channel";

const startGatewayAccount = (ctx: any) => dingtalkPlugin.gateway!.startAccount!(ctx);

function createStartContext() {
  let status = {
    accountId: "main",
    running: false,
    lastStartAt: null as number | null,
    lastStopAt: null as number | null,
    lastError: null as string | null,
  };

  return {
    cfg: {},
    account: {
      accountId: "main",
      config: { clientId: "ding_id", clientSecret: "ding_secret" },
    },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    getStatus: () => status,
    setStatus: (next: typeof status) => {
      status = next;
    },
  };
}

describe("gateway inbound callback pipeline", () => {
  beforeEach(() => {
    shared.connectMock.mockReset();
    shared.waitForStopMock.mockReset();
    shared.stopMock.mockReset();
    shared.isConnectedMock.mockReset();
    shared.socketCallBackResponseMock.mockReset();
    shared.isMessageProcessedMock.mockReset();
    shared.markMessageProcessedMock.mockReset();
    shared.handleDingTalkMessageMock.mockReset();
    shared.sendProactiveTextMock.mockReset();
    shared.connectionConfig = undefined;

    shared.listeners = {};
    shared.connectMock.mockResolvedValue(undefined);
    shared.waitForStopMock.mockResolvedValue(undefined);
    shared.isConnectedMock.mockReturnValue(false);
    shared.sendProactiveTextMock.mockResolvedValue({});
  });

  it("acknowledges callback after successful dispatch for non-duplicate message", async () => {
    shared.isMessageProcessedMock.mockReturnValue(false);
    const ctx = createStartContext();

    await startGatewayAccount(ctx as any);

    expect(shared.listeners.TOPIC_ROBOT).toBeTypeOf("function");

    await shared.listeners.TOPIC_ROBOT?.({
      headers: { messageId: "stream_msg_1" },
      data: JSON.stringify({
        msgId: "msg_1",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cidA1B2C3",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://webhook",
      }),
    });

    expect(shared.socketCallBackResponseMock).toHaveBeenCalledTimes(1);
    expect(shared.socketCallBackResponseMock).toHaveBeenCalledWith("stream_msg_1", {
      success: true,
    });
    expect(shared.markMessageProcessedMock).toHaveBeenCalledWith("ding_id:msg_1");
    expect(shared.handleDingTalkMessageMock).toHaveBeenCalledTimes(1);
    expect(shared.handleDingTalkMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main",
        sessionWebhook: "https://webhook",
      }),
    );
  });

  it("skips duplicate message dispatch when dedup indicates already processed", async () => {
    shared.isMessageProcessedMock.mockReturnValue(true);
    const ctx = createStartContext();

    await startGatewayAccount(ctx as any);

    await shared.listeners.TOPIC_ROBOT?.({
      headers: { messageId: "stream_msg_2" },
      data: JSON.stringify({
        msgId: "msg_2",
        msgtype: "text",
        text: { content: "hello duplicate" },
        conversationType: "1",
        conversationId: "cidA1B2C3",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://webhook",
      }),
    });

    expect(shared.markMessageProcessedMock).not.toHaveBeenCalled();
    expect(shared.handleDingTalkMessageMock).not.toHaveBeenCalled();
    expect(ctx.log.info).toHaveBeenCalledWith(
      expect.stringContaining("Inbound counters (dedup-skipped)"),
    );
  });

  it("does not mark dedup when handler fails, allowing retries", async () => {
    shared.isMessageProcessedMock.mockReturnValue(false);
    shared.handleDingTalkMessageMock
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValueOnce(undefined);
    const ctx = createStartContext();

    await startGatewayAccount(ctx as any);

    const payload = {
      headers: { messageId: "stream_msg_retry" },
      data: JSON.stringify({
        msgId: "msg_retry",
        msgtype: "text",
        text: { content: "retry me" },
        conversationType: "1",
        conversationId: "cidA1B2C3",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://webhook",
      }),
    };

    await shared.listeners.TOPIC_ROBOT?.(payload);
    expect(shared.markMessageProcessedMock).not.toHaveBeenCalled();
    // Early ack: acknowledge() is called before the handler, so even on failure the callback is acked
    expect(shared.socketCallBackResponseMock).toHaveBeenCalledTimes(1);
    expect(shared.socketCallBackResponseMock).toHaveBeenCalledWith("stream_msg_retry", {
      success: true,
    });
    expect(ctx.log.info).toHaveBeenCalledWith(expect.stringContaining("Inbound counters (failed)"));

    await shared.listeners.TOPIC_ROBOT?.(payload);
    expect(shared.handleDingTalkMessageMock).toHaveBeenCalledTimes(2);
    expect(shared.markMessageProcessedMock).toHaveBeenCalledTimes(1);
    expect(shared.markMessageProcessedMock).toHaveBeenCalledWith("ding_id:msg_retry");
    // Both attempts ack immediately
    expect(shared.socketCallBackResponseMock).toHaveBeenCalledTimes(2);
    expect(shared.socketCallBackResponseMock).toHaveBeenNthCalledWith(2, "stream_msg_retry", {
      success: true,
    });
  });

  it("does not acknowledge malformed payloads when parse fails", async () => {
    shared.isMessageProcessedMock.mockReturnValue(false);
    const ctx = createStartContext();

    await startGatewayAccount(ctx as any);

    await shared.listeners.TOPIC_ROBOT?.({
      headers: { messageId: "stream_msg_bad" },
      data: '{"msgId":',
    });

    expect(shared.socketCallBackResponseMock).not.toHaveBeenCalled();
    expect(shared.handleDingTalkMessageMock).not.toHaveBeenCalled();
    expect(ctx.log.info).toHaveBeenCalledWith(expect.stringContaining("Inbound counters (failed)"));
  });

  it("skips concurrent in-flight duplicate callbacks for same message without acking the duplicate", async () => {
    shared.isMessageProcessedMock.mockReturnValue(false);
    let resolveFirst: (() => void) | undefined;
    shared.handleDingTalkMessageMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const ctx = createStartContext();

    await startGatewayAccount(ctx as any);

    const payloadData = JSON.stringify({
      msgId: "msg_inflight",
      msgtype: "text",
      text: { content: "in flight" },
      conversationType: "1",
      conversationId: "cidA1B2C3",
      senderId: "user_1",
      chatbotUserId: "bot_1",
      sessionWebhook: "https://webhook",
    });

    const first = shared.listeners.TOPIC_ROBOT?.({
      headers: { messageId: "stream_msg_inflight_1" },
      data: payloadData,
    });
    const second = shared.listeners.TOPIC_ROBOT?.({
      headers: { messageId: "stream_msg_inflight_2" },
      data: payloadData,
    });

    await Promise.resolve();
    expect(shared.handleDingTalkMessageMock).toHaveBeenCalledTimes(1);
    expect(shared.markMessageProcessedMock).not.toHaveBeenCalled();

    resolveFirst?.();
    await first;
    await second;

    expect(shared.markMessageProcessedMock).toHaveBeenCalledTimes(1);
    expect(shared.markMessageProcessedMock).toHaveBeenCalledWith("ding_id:msg_inflight");
    // Both the first message and the in-flight duplicate are acked immediately
    expect(shared.socketCallBackResponseMock).toHaveBeenCalledTimes(2);
    expect(shared.socketCallBackResponseMock).toHaveBeenCalledWith("stream_msg_inflight_1", {
      success: true,
    });
    expect(shared.socketCallBackResponseMock).toHaveBeenCalledWith("stream_msg_inflight_2", {
      success: true,
    });
  });

  it("does NOT release in-flight lock by wall-clock ttl (queue wait > old ttl must not duplicate)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
      shared.isMessageProcessedMock.mockReturnValue(false);
      let resolveFirst: (() => void) | undefined;
      shared.handleDingTalkMessageMock
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockResolvedValueOnce(undefined);
      const ctx = createStartContext();

      await startGatewayAccount(ctx as any);

      const payloadData = JSON.stringify({
        msgId: "msg_stale",
        msgtype: "text",
        text: { content: "stale me" },
        conversationType: "1",
        conversationId: "cidA1B2C3",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://webhook",
      });

      const first = shared.listeners.TOPIC_ROBOT?.({
        headers: { messageId: "stream_msg_stale_1" },
        data: payloadData,
      });
      await Promise.resolve();

      // Advance well past the historical 5-minute TTL — and even past the
      // 15-minute max queue wait. The handler has not settled (resolveFirst
      // has not been called), so the in-flight lock MUST remain held and a
      // DingTalk retry arriving now must be skipped, not reprocessed.
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

      const second = shared.listeners.TOPIC_ROBOT?.({
        headers: { messageId: "stream_msg_stale_2" },
        data: payloadData,
      });

      await Promise.resolve();
      // The handler-owned queue can hold a message for up to 15 minutes; the
      // old 5-minute gateway TTL would have released this lock and let the
      // resend enter a SECOND handler invocation. The lock is now released
      // only by the handler's `finally`, so the duplicate is dropped.
      expect(shared.handleDingTalkMessageMock).toHaveBeenCalledTimes(1);
      expect(shared.handleDingTalkMessageMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ inboundOrigin: "stream", inboundQueueEligible: true }),
      );
      expect(ctx.log.debug).toHaveBeenCalledWith(
        expect.stringContaining("Skipping in-flight duplicate message"),
      );
      expect(ctx.log.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("Releasing stale in-flight lock"),
      );

      resolveFirst?.();
      await first;
      await second;

      // Still only one handler invocation: the duplicate never escaped the
      // gateway's in-flight guard.
      expect(shared.handleDingTalkMessageMock).toHaveBeenCalledTimes(1);
      expect(shared.markMessageProcessedMock).toHaveBeenCalledWith("ding_id:msg_stale");
    } finally {
      vi.useRealTimers();
    }
  });

  it("acknowledges card callbacks and sends feedback ack for feedback buttons", async () => {
    const ctx = createStartContext();

    await startGatewayAccount(ctx as any);

    expect(shared.listeners.TOPIC_CARD).toBeTypeOf("function");

    await shared.listeners.TOPIC_CARD?.({
      headers: { messageId: "card_callback_1" },
      data: JSON.stringify({
        value: JSON.stringify({ cardPrivateData: { actionIds: ["feedback_up"] } }),
        spaceType: "IM",
        userId: "user_feedback_1",
      }),
    });

    expect(shared.sendProactiveTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "ding_id" }),
      "user_feedback_1",
      "✅ 已收到你的点赞（反馈已记录）",
      expect.objectContaining({ accountId: "main" }),
    );
    expect(shared.socketCallBackResponseMock).toHaveBeenCalledWith("card_callback_1", {
      success: true,
    });
  });

  it("does NOT clear in-flight locks on disconnect (resend after reconnect must skip, not duplicate)", async () => {
    shared.isMessageProcessedMock.mockReturnValue(false);
    let resolveFirst: (() => void) | undefined;
    shared.handleDingTalkMessageMock
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);
    const ctx = createStartContext();

    await startGatewayAccount(ctx as any);

    const payloadData = JSON.stringify({
      msgId: "msg_disconnect",
      msgtype: "text",
      text: { content: "disconnect me" },
      conversationType: "1",
      conversationId: "cidA1B2C3",
      senderId: "user_1",
      chatbotUserId: "bot_1",
      sessionWebhook: "https://webhook",
    });

    const first = shared.listeners.TOPIC_ROBOT?.({
      headers: { messageId: "stream_msg_disconnect_1" },
      data: payloadData,
    });
    await Promise.resolve();

    shared.connectionConfig?.onStateChange?.("DISCONNECTED", "lost");

    const second = shared.listeners.TOPIC_ROBOT?.({
      headers: { messageId: "stream_msg_disconnect_2" },
      data: payloadData,
    });

    // The handler has not settled, so the in-flight lock must remain held
    // across the disconnect; DingTalk will resend after reconnect and a
    // cleared lock would let the resend enter a SECOND handler invocation.
    // Only `finally` after the handler settles releases a key.
    resolveFirst?.();
    await first;
    await second;

    await Promise.resolve();
    expect(shared.handleDingTalkMessageMock).toHaveBeenCalledTimes(1);
    expect(ctx.log.info).not.toHaveBeenCalledWith(
      expect.stringContaining("Cleared"),
    );
    expect(ctx.log.debug).toHaveBeenCalledWith(
      expect.stringContaining("Skipping in-flight duplicate message"),
    );
  });

  it("channel inflight namespace is memory-only", () => {
    expect(CHANNEL_INFLIGHT_NAMESPACE_POLICY).toBe("memory-only");
  });
});
