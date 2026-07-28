import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMessage,
  cardSerial,
  cleanupInboundSessionQueueIntegrationTest,
  dispatch,
  queueInput,
  resetInboundSessionQueueIntegrationTest,
  shared,
  STORE_PATH,
} from "../unit/fixtures/inbound-session-queue-fixture";
import { QUEUE_BUSY_ACK_PHRASES } from "../../src/gateway/inbound-session-queue";
import { dispatchInboundViaSessionQueue } from "../../src/gateway/inbound-session-queue-dispatcher";
import { handleDingTalkMessage } from "../../src/inbound-handler";

describe('inbound session queue recovery and bypass', () => {
  beforeEach(resetInboundSessionQueueIntegrationTest);
  afterEach(cleanupInboundSessionQueueIntegrationTest);
  it("recalls a failed initial queue ACK before falling back to a fresh reply", async () => {
    shared.extractMessageContentMock.mockImplementation((data: any) => ({
      text: data?.text?.content,
      messageType: "text",
    }));
    const queuedCard = {
      cardInstanceId: "card_initial_stream_failure",
      outTrackId: "track_initial_stream_failure",
      state: "INPUTING",
      storePath: STORE_PATH,
      lastUpdated: Date.now(),
    };
    shared.createAICardMock.mockResolvedValue(queuedCard);
    shared.isCardInTerminalStateMock.mockReturnValue(false);
    shared.streamAICardMock.mockRejectedValueOnce(new Error("initial stream failed"));

    let releaseFirst: () => void = () => {};
    let resolveFirstStarted: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    const first = dispatchInboundViaSessionQueue(
      queueInput(buildMessage("查询", "msg_initial_stream_active")),
      async () => {
        resolveFirstStarted();
        await firstGate;
      },
    );
    await firstStarted;
    const handler = vi.fn().mockResolvedValue(undefined);
    const queued = dispatchInboundViaSessionQueue(
      queueInput(buildMessage("确认", "msg_initial_stream_queued")),
      handler,
    );
    await vi.waitFor(() => expect(shared.streamAICardMock).toHaveBeenCalled());

    releaseFirst();
    await Promise.all([first, queued]);

    expect(shared.recallAICardMessageMock).toHaveBeenCalledWith(queuedCard, undefined);
    expect(handler).toHaveBeenCalledWith(undefined);
  });

  it("recalls an unused pre-created queue ACK card after a non-card handler returns", async () => {
      shared.extractMessageContentMock.mockImplementation((data: any) => ({
        text: data?.text?.content,
        messageType: "text",
      }));
      const queuedCard = {
        cardInstanceId: "card_unused_queue_ack",
        outTrackId: "track_unused_queue_ack",
        state: "INPUTING",
        storePath: STORE_PATH,
        lastUpdated: Date.now(),
      };
      shared.createAICardMock.mockResolvedValue(queuedCard);
      shared.isCardInTerminalStateMock.mockReturnValue(false);
      let releaseFirst: () => void = () => {};
      let resolveFirstStarted: () => void = () => {};
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const firstStarted = new Promise<void>((resolve) => {
        resolveFirstStarted = resolve;
      });
      const first = dispatchInboundViaSessionQueue(
        queueInput(buildMessage("查询", "msg_unused_active")),
        async () => {
          resolveFirstStarted();
          await firstGate;
        },
      );
      await firstStarted;
      const queued = dispatchInboundViaSessionQueue(
        queueInput(buildMessage("另一个命令", "msg_unused_queued")),
        async () => undefined,
      );
      await vi.waitFor(() => expect(shared.streamAICardMock).toHaveBeenCalled());

      releaseFirst();
      await Promise.all([first, queued]);
      expect(shared.recallAICardMessageMock).toHaveBeenCalledWith(queuedCard, undefined);
    });

    it("finishes a queued ACK with a retryable failure when its handler throws", async () => {
      shared.extractMessageContentMock.mockImplementation((data: any) => ({
        text: data?.text?.content,
        messageType: "text",
      }));
      const queuedCard = {
        cardInstanceId: "card_failed_queue_ack",
        outTrackId: "track_failed_queue_ack",
        state: "INPUTING",
        storePath: STORE_PATH,
        lastUpdated: Date.now(),
      };
      shared.createAICardMock.mockResolvedValue(queuedCard);
      shared.isCardInTerminalStateMock.mockReturnValue(false);

      let releaseFirst: () => void = () => {};
      let resolveFirstStarted: () => void = () => {};
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const firstStarted = new Promise<void>((resolve) => {
        resolveFirstStarted = resolve;
      });
      const first = dispatchInboundViaSessionQueue(
        queueInput(buildMessage("查询", "msg_failure_active")),
        async () => {
          resolveFirstStarted();
          await firstGate;
        },
      );
      await firstStarted;
      const queued = dispatchInboundViaSessionQueue(
        queueInput(buildMessage("确认", "msg_failure_queued")),
        async () => {
          throw new Error("sessions.json EBUSY");
        },
      ).catch((error: unknown) => error);
      await vi.waitFor(() => expect(shared.streamAICardMock).toHaveBeenCalled());

      releaseFirst();
      await first;
      const error = await queued;

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("sessions.json EBUSY");
      expect(shared.recallAICardMessageMock).not.toHaveBeenCalledWith(queuedCard, undefined);
      expect(shared.streamAICardMock).toHaveBeenCalledWith(
        queuedCard,
        expect.stringContaining("本次处理异常"),
        true,
        undefined,
      );
    });

    it("sends a text fallback when a queued failure card cannot be finalized", async () => {
      shared.extractMessageContentMock.mockImplementation((data: any) => ({
        text: data?.text?.content,
        messageType: "text",
      }));
      const queuedCard = {
        cardInstanceId: "card_failed_terminal_update",
        outTrackId: "track_failed_terminal_update",
        state: "INPUTING",
        storePath: STORE_PATH,
        lastUpdated: Date.now(),
      };
      shared.createAICardMock.mockResolvedValue(queuedCard);
      shared.isCardInTerminalStateMock.mockReturnValue(false);
      shared.streamAICardMock
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("terminal stream failed"));

      let releaseFirst: () => void = () => {};
      let resolveFirstStarted: () => void = () => {};
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const firstStarted = new Promise<void>((resolve) => {
        resolveFirstStarted = resolve;
      });
      const first = dispatchInboundViaSessionQueue(
        queueInput(buildMessage("查询", "msg_terminal_failure_active")),
        async () => {
          resolveFirstStarted();
          await firstGate;
        },
      );
      await firstStarted;
      const queued = dispatchInboundViaSessionQueue(
        queueInput(buildMessage("确认", "msg_terminal_failure_queued")),
        async () => {
          throw new Error("handler failed");
        },
      ).catch((error: unknown) => error);
      await vi.waitFor(() => expect(shared.streamAICardMock).toHaveBeenCalledTimes(1));

      releaseFirst();
      const [, error] = await Promise.all([first, queued]);

      expect(error).toMatchObject({ message: "handler failed" });
      expect(shared.createAICardMock).toHaveBeenCalledTimes(1);
      expect(shared.sendMessageMock).toHaveBeenCalledTimes(1);
      expect(shared.sendMessageMock).toHaveBeenCalledWith(
        expect.anything(),
        "user-queue",
        expect.stringContaining("本次处理异常"),
        expect.objectContaining({ sessionWebhook: expect.any(String) }),
      );
    });

  it("ask-user reinjections BYPASS the queue (no queue-busy ACK card prepared)", async () => {
    let resolveFirstDispatchStarted: () => void = () => {};
    const firstDispatchStarted = new Promise<void>((resolve) => {
      resolveFirstDispatchStarted = resolve;
    });
    shared.createAICardMock.mockImplementation(async () => ({
      cardInstanceId: `card_${(cardSerial.value += 1)}`,
      outTrackId: `card_${cardSerial.value}`,
      state: "INPUTING",
      storePath: STORE_PATH,
      lastStreamedContent: "",
      lastUpdated: Date.now(),
    }));
    shared.isCardInTerminalStateMock.mockReturnValue(false);
    shared.extractMessageContentMock.mockImplementation((data: any) => ({
      text: data?.text?.content,
      messageType: "text",
    }));

    // A (stream) is an active run whose dispatch hangs, keeping the
    // conversation's queue busy.
    let resolveADispatch: () => void = () => {};
    const aDispatchGate = new Promise<void>((resolve) => {
      resolveADispatch = resolve;
    });
    let dispatchCallCount = 0;
    shared.dispatchMock.mockImplementation(() => {
      dispatchCallCount += 1;
      if (dispatchCallCount === 1) {
        resolveFirstDispatchStarted();
        return aDispatchGate.then(() => ({ queuedFinal: undefined }));
      }
      return Promise.resolve({ queuedFinal: undefined });
    });

    const aPromise = dispatch(buildMessage("提问", "msg_a"));
    await firstDispatchStarted;

    // An ask-user answer is delivered by a DIRECT call to handleDingTalkMessage
    // (ask-user-question.ts does this) — it never enters the gateway dispatcher,
    // so the queue is bypassed and NO queue-busy ACK card is prepared for it.
    const answerMsg = buildMessage("答复", "msg_answer");
    answerMsg.inboundOrigin = "ask-user";
    const answerPromise = handleDingTalkMessage(answerMsg);
    // Let the dispatcher run synchronously up to its first real await.
    await Promise.resolve();
    await Promise.resolve();

    const ackStreamCalls = shared.streamAICardMock.mock.calls.filter((call: any[]) =>
      (QUEUE_BUSY_ACK_PHRASES as readonly string[]).includes(call[1]),
    );
    expect(ackStreamCalls.length).toBe(0);

    // Release A so the answer (which still acquires the per-session lock inside
    // the handler) can proceed and the test leaves no pending work behind.
    resolveADispatch();
    await Promise.all([aPromise, answerPromise]);
    expect(shared.dispatchMock).toHaveBeenCalledTimes(2);
  });
});
