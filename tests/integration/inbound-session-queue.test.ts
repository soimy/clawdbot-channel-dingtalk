import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMessage,
  cardSerial,
  cleanupInboundSessionQueueIntegrationTest,
  dispatch,
  queueInput,
  resetInboundSessionQueueIntegrationTest,
  SESSION_KEY,
  shared,
  STORE_PATH,
} from "../unit/fixtures/inbound-session-queue-fixture";
import {
  chainInboundSessionTask,
  MAX_INBOUND_SESSION_QUEUE_DEPTH,
  MAX_INBOUND_SESSION_QUEUE_WAIT_MS,
  QUEUE_BUSY_ACK_PHRASES,
} from "../../src/gateway/inbound-session-queue";
import { dispatchInboundViaSessionQueue } from "../../src/gateway/inbound-session-queue-dispatcher";
import { handleDingTalkMessage } from "../../src/inbound-handler";

describe('inbound session queue (钉钉"确认"无响应 regression)', () => {
  beforeEach(resetInboundSessionQueueIntegrationTest);
  afterEach(cleanupInboundSessionQueueIntegrationTest);
  it("queues a busy message, acks it on a pre-created card, then auto-reprocesses it (no drop, in-place card)", async () => {
    let resolveFirstDispatchStarted: () => void = () => {};
    const firstDispatchStarted = new Promise<void>((resolve) => {
      resolveFirstDispatchStarted = resolve;
    });
    let resolveQueuedAckStreamed: () => void = () => {};
    const queuedAckStreamed = new Promise<void>((resolve) => {
      resolveQueuedAckStreamed = resolve;
    });
    let queuedAckVisibleAt = 0;
    let queuedDispatchStartedAt = 0;
    // Each createAICard call yields a distinct fake card so we can tell the
    // active run's card apart from the queued message's ACK card.
    shared.createAICardMock.mockImplementation(async () => ({
      cardInstanceId: `card_${(cardSerial.value += 1)}`,
      outTrackId: `card_${cardSerial.value}`,
      state: "INPUTING",
      storePath: STORE_PATH,
      lastStreamedContent: "",
      lastUpdated: Date.now(),
    }));
    shared.isCardInTerminalStateMock.mockReturnValue(false);
    shared.streamAICardMock.mockImplementation(async (_card: unknown, content: string) => {
      if ((QUEUE_BUSY_ACK_PHRASES as readonly string[]).includes(content)) {
        queuedAckVisibleAt = Date.now();
        resolveQueuedAckStreamed();
      }
    });
    shared.extractMessageContentMock.mockImplementation((data: any) => ({
      text: data?.text?.content,
      messageType: "text",
    }));

    // A's core dispatch hangs on a gate to simulate a long active run.
    let resolveADispatch: () => void = () => {};
    const aDispatchGate = new Promise<void>((resolve) => {
      resolveADispatch = resolve;
    });
    let dispatchCallCount = 0;
    shared.dispatchMock.mockImplementation(() => {
      dispatchCallCount += 1;
      if (dispatchCallCount === 1) {
        resolveFirstDispatchStarted();
        // A: hang until the test releases it.
        return aDispatchGate.then(() => ({ queuedFinal: undefined }));
        }
        // B (and beyond): resolve immediately.
        queuedDispatchStartedAt = Date.now();
        return Promise.resolve({ queuedFinal: undefined });
    });

    // A arrives first on an idle queue → runs immediately.
    const aPromise = dispatch(buildMessage("查询A", "msg_a"));
    // Wait on the actual handler call rather than timer polling: this is
    // stable under CI worker contention.
    await firstDispatchStarted;

    // While A is still running, B arrives on the SAME conversation.
    const bPromise = dispatch(buildMessage("确认", "msg_b"));
    await queuedAckStreamed;

    // Assertion 1: B is QUEUED — its core dispatch has NOT started while A runs.
    expect(shared.dispatchMock).toHaveBeenCalledTimes(1);

    // Assertion 2: B's ACK was streamed onto a pre-created card with a
    // queue-busy acknowledgement phrase.
    const ackStreamCalls = shared.streamAICardMock.mock.calls.filter((call: any[]) =>
      (QUEUE_BUSY_ACK_PHRASES as readonly string[]).includes(call[1]),
    );
    expect(ackStreamCalls.length).toBe(1);

    // Now release A's long-running dispatch.
    resolveADispatch();
    await Promise.all([aPromise, bPromise]);

    // Assertion 3: B was auto-reprocessed after A finished — its dispatch ran.
    // Total dispatch calls = 2 (A then B), in order.
    expect(shared.dispatchMock).toHaveBeenCalledTimes(2);
    expect(queuedDispatchStartedAt - queuedAckVisibleAt).toBeGreaterThanOrEqual(700);

    // Assertion 4: B reused its pre-created ACK card — createAICard was called
    // exactly twice (A's real card + B's ACK card), NOT three times (B did not
    // create a second real card; it streamed its reply into the ACK card).
    expect(shared.createAICardMock).toHaveBeenCalledTimes(2);
    // The 2nd createAICard call is B's ACK card, prepared from the inbound
    // "确认" text (quoteContent). Use find() to be tolerant of the `log`
    // argument being undefined (expect.anything() rejects undefined).
    const bAckCreateCall = shared.createAICardMock.mock.calls.find(
      (call: any[]) => call[3]?.quoteContent === "确认",
    );
    expect(bAckCreateCall).toBeTruthy();
  });

  it("expires a queued message with a terminal card update without running its handler", async () => {
    let resolveFirstDispatchStarted: () => void = () => {};
    const firstDispatchStarted = new Promise<void>((resolve) => {
      resolveFirstDispatchStarted = resolve;
    });
    let resolveQueuedAckStreamed: () => void = () => {};
    const queuedAckStreamed = new Promise<void>((resolve) => {
      resolveQueuedAckStreamed = resolve;
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
    shared.streamAICardMock.mockImplementation(async (_card: unknown, content: string) => {
      if ((QUEUE_BUSY_ACK_PHRASES as readonly string[]).includes(content)) {
        resolveQueuedAckStreamed();
      }
    });
    shared.extractMessageContentMock.mockImplementation((data: any) => ({
      text: data?.text?.content,
      messageType: "text",
    }));
    vi.useFakeTimers({ toFake: ["setTimeout"] });

    let resolveADispatch: () => void = () => {};
    const aDispatchGate = new Promise<void>((resolve) => {
      resolveADispatch = resolve;
    });
    shared.dispatchMock.mockImplementation(() => {
      resolveFirstDispatchStarted();
      return aDispatchGate.then(() => ({ queuedFinal: undefined }));
    });

    const aPromise = dispatch(buildMessage("查询A", "msg_timeout_a"));
    await firstDispatchStarted;
    const bPromise = dispatch(buildMessage("确认", "msg_timeout_b"));
    await queuedAckStreamed;

    await vi.advanceTimersByTimeAsync(MAX_INBOUND_SESSION_QUEUE_WAIT_MS);
    await bPromise;

    expect(shared.dispatchMock).toHaveBeenCalledTimes(1);
    const timeoutUpdate = shared.streamAICardMock.mock.calls.find(
      (call: any[]) => call[1].includes("这条消息未执行") && call[2] === true,
    );
    expect(timeoutUpdate).toBeTruthy();

    resolveADispatch();
    await aPromise;
    // The expired task stays in the serialized tail only long enough to skip
    // itself; it must never dispatch after the active run finishes.
    expect(shared.dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a message beyond the per-conversation depth cap without invoking its handler", async () => {
    shared.createAICardMock.mockResolvedValue(null);
    let releaseActive: () => void = () => {};
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const queued = [chainInboundSessionTask(SESSION_KEY, () => activeGate)];
    for (let index = 1; index < MAX_INBOUND_SESSION_QUEUE_DEPTH; index += 1) {
      queued.push(chainInboundSessionTask(SESSION_KEY, async () => undefined));
    }
    const rejectedHandler = vi.fn(async () => undefined);
    await dispatchInboundViaSessionQueue(
      queueInput(buildMessage("确认", "msg_queue_full")),
      rejectedHandler,
    );

    expect(rejectedHandler).not.toHaveBeenCalled();
    expect(shared.sendMessageMock).toHaveBeenCalledTimes(1);
    expect(shared.sendMessageMock.mock.calls[0][2]).toContain("排队上限");

    releaseActive();
    await Promise.all(queued);
  });

  it("reserves depth before asynchronous ACK creation so a burst cannot over-admit", async () => {
    // A null card keeps the ACK path asynchronous (one promise turn) while
    // making terminal overflow replies fall back to sendMessage.
    shared.createAICardMock.mockResolvedValue(null);
    let releaseActive: () => void = () => {};
    let resolveActiveStarted: () => void = () => {};
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const activeStarted = new Promise<void>((resolve) => {
      resolveActiveStarted = resolve;
    });
    const active = dispatchInboundViaSessionQueue(
      queueInput(buildMessage("查询A", "msg_burst_active")),
      async () => {
        resolveActiveStarted();
        await activeGate;
      },
    );
    await activeStarted;

    const admittedHandlers = Array.from({ length: MAX_INBOUND_SESSION_QUEUE_DEPTH - 1 }, () =>
      vi.fn(async () => undefined),
    );
    const overflowHandlers = [vi.fn(async () => undefined), vi.fn(async () => undefined)];
    const burst = [...admittedHandlers, ...overflowHandlers].map((handler, index) =>
      dispatchInboundViaSessionQueue(
        queueInput(buildMessage("确认", `msg_burst_${index}`)),
        handler,
      ),
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(shared.sendMessageMock).toHaveBeenCalledTimes(2);
    expect(admittedHandlers.every((handler) => handler.mock.calls.length === 0)).toBe(true);
    expect(overflowHandlers.every((handler) => handler.mock.calls.length === 0)).toBe(true);

    releaseActive();
    await Promise.all([active, ...burst]);
    expect(admittedHandlers.every((handler) => handler.mock.calls.length === 1)).toBe(true);
    expect(overflowHandlers.every((handler) => handler.mock.calls.length === 0)).toBe(true);
  });

    it("does not discard a manual resend with the same text while its first copy is active", async () => {
      shared.createAICardMock.mockResolvedValue(null);
      shared.extractMessageContentMock.mockImplementation((data: any) => ({
        text: data?.text?.content,
        messageType: "text",
      }));
      let releaseFirst: () => void = () => {};
      let resolveFirstStarted: () => void = () => {};
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const firstStarted = new Promise<void>((resolve) => {
        resolveFirstStarted = resolve;
      });
      const first = dispatchInboundViaSessionQueue(
        queueInput(buildMessage("确认", "msg_duplicate_first")),
        async () => {
          resolveFirstStarted();
          await firstGate;
        },
      );
      await firstStarted;

      const duplicateHandler = vi.fn(async () => undefined);
      const second = dispatchInboundViaSessionQueue(
        queueInput(buildMessage("确认", "msg_duplicate_resend")),
        duplicateHandler,
      );
      await Promise.resolve();
      expect(duplicateHandler).not.toHaveBeenCalled();
      releaseFirst();
      await Promise.all([first, second]);
      expect(duplicateHandler).toHaveBeenCalledTimes(1);
    });

    it("bypasses the authorized queue for /stop while the same session is active", async () => {
      shared.extractMessageContentMock.mockImplementation((data: any) => ({
        text: data?.text?.content,
        messageType: "text",
      }));
      shared.isAbortRequestTextMock.mockImplementation((text: string) => text === "/stop");
      let releaseActive: () => void = () => {};
      let resolveActiveStarted: () => void = () => {};
      const activeGate = new Promise<void>((resolve) => {
        releaseActive = resolve;
      });
      const activeStarted = new Promise<void>((resolve) => {
        resolveActiveStarted = resolve;
      });
      let callCount = 0;
      shared.dispatchMock.mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) {
          resolveActiveStarted();
          return activeGate.then(() => ({ queuedFinal: undefined }));
        }
        return Promise.resolve({ queuedFinal: undefined });
      });

      const active = dispatch(buildMessage("长任务", "msg_stop_active"));
      await activeStarted;
      const stop = dispatch(buildMessage("/stop", "msg_stop_bypass"));

      await vi.waitFor(() => expect(shared.dispatchMock).toHaveBeenCalledTimes(2));
      releaseActive();
      await Promise.all([active, stop]);
    });

    it("bypasses the authorized queue for /btw while the same session is active", async () => {
      shared.extractMessageContentMock.mockImplementation((data: any) => ({
        text: data?.text?.content,
        messageType: "text",
      }));
      shared.isBtwRequestTextMock.mockImplementation((text: string) => text === "/btw status");
      let releaseActive: () => void = () => {};
      let resolveActiveStarted: () => void = () => {};
      const activeGate = new Promise<void>((resolve) => {
        releaseActive = resolve;
      });
      const activeStarted = new Promise<void>((resolve) => {
        resolveActiveStarted = resolve;
      });
      let callCount = 0;
      shared.dispatchMock.mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) {
          resolveActiveStarted();
          return activeGate.then(() => ({ queuedFinal: undefined }));
        }
        return Promise.resolve({ queuedFinal: undefined });
      });

      const active = dispatch(buildMessage("长任务", "msg_btw_active"));
      await activeStarted;
      const sideQuestion = dispatch(buildMessage("/btw status", "msg_btw_bypass"));

      await vi.waitFor(() => expect(shared.dispatchMock).toHaveBeenCalledTimes(2));
      releaseActive();
      await Promise.all([active, sideQuestion]);
    });

    it("does not create a queue acknowledgement for an unauthorized group message", async () => {
      shared.extractMessageContentMock.mockImplementation((data: any) => ({
        text: data?.text?.content,
        messageType: "text",
      }));
      const activeGate = new Promise<void>(() => {});
      void chainInboundSessionTask(SESSION_KEY, () => activeGate);
      const blocked = buildMessage("确认", "msg_group_blocked");
      blocked.data.conversationType = "2";
      blocked.data.conversationId = "cid_blocked_group";
      blocked.dingtalkConfig = {
        ...blocked.dingtalkConfig,
        groupPolicy: "allowlist",
        groups: {},
        messageType: "card",
      };

      await handleDingTalkMessage(blocked);

      expect(shared.createAICardMock).not.toHaveBeenCalled();
      expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    });

});
