import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QUEUE_BUSY_ACK_PHRASES,
  chainInboundSessionTask,
  deriveInboundQueueKey,
  getInboundSessionQueueDepth,
  inboundSessionQueueBusyKeysForTest,
  isInboundSessionQueueBusy,
  pickQueueBusyAckPhrase,
  resetInboundSessionQueueForTest,
} from "../../src/gateway/inbound-session-queue";

describe("deriveInboundQueueKey", () => {
  it("groups by accountId + conversationId", () => {
    expect(deriveInboundQueueKey({ accountId: "main", conversationId: "cidA" })).toBe("main:cidA");
  });

  it("returns null when inputs are missing", () => {
    expect(deriveInboundQueueKey({ accountId: "", conversationId: "cidA" })).toBeNull();
    expect(deriveInboundQueueKey({ accountId: "main", conversationId: "" })).toBeNull();
    expect(deriveInboundQueueKey({ accountId: "main" })).toBeNull();
  });

  it("trims whitespace", () => {
    expect(deriveInboundQueueKey({ accountId: "  main  ", conversationId: "  cidA  " })).toBe(
      "main:cidA",
    );
  });
});

describe("pickQueueBusyAckPhrase", () => {
  it("returns one of the fixed phrases", () => {
    expect(QUEUE_BUSY_ACK_PHRASES).toContain(pickQueueBusyAckPhrase());
  });

  it("is deterministic with a seed", () => {
    expect(pickQueueBusyAckPhrase(0)).toBe(QUEUE_BUSY_ACK_PHRASES[0]);
    expect(pickQueueBusyAckPhrase(1)).toBe(QUEUE_BUSY_ACK_PHRASES[1]);
    expect(pickQueueBusyAckPhrase(2)).toBe(QUEUE_BUSY_ACK_PHRASES[2]);
    // wraps modulo
    expect(pickQueueBusyAckPhrase(3)).toBe(QUEUE_BUSY_ACK_PHRASES[0]);
  });
});

describe("chainInboundSessionTask", () => {
  afterEach(() => {
    resetInboundSessionQueueForTest();
  });

  // The chain tail self-cleans via `tail.finally()`, which runs in a microtask
  // after the task settles. Flush a few microtasks before asserting the queue
  // is idle.
  const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  it("runs a single task immediately and reports busy while in-flight", async () => {
    let resolveA: () => void = () => {};
    const aDone = new Promise<void>((resolve) => {
      resolveA = resolve;
    });
    const order: string[] = [];

    const pending = chainInboundSessionTask("s1", async () => {
      order.push("a-start");
      await aDone;
      order.push("a-end");
    });

    // While the task is in-flight the queue is busy for s1.
    expect(isInboundSessionQueueBusy("s1")).toBe(true);
    expect(inboundSessionQueueBusyKeysForTest()).toEqual(["s1"]);

    resolveA();
    await pending;
    await flushMicrotasks();

    expect(order).toEqual(["a-start", "a-end"]);
    // Queue drained → no longer busy.
    expect(isInboundSessionQueueBusy("s1")).toBe(false);
    expect(inboundSessionQueueBusyKeysForTest()).toEqual([]);
  });

  it("serializes tasks in arrival order (B does not start until A finishes)", async () => {
    let resolveA: () => void = () => {};
    const aGate = new Promise<void>((resolve) => {
      resolveA = resolve;
    });
    const order: string[] = [];

    const a = chainInboundSessionTask("s1", async () => {
      order.push("a-start");
      await aGate;
      order.push("a-end");
    });
    // B arrives while A is still running.
    const b = chainInboundSessionTask("s1", async () => {
      order.push("b-start");
      order.push("b-end");
    });

    // Give B's chain a tick to be scheduled; it must NOT start before A resolves.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["a-start"]);

    resolveA();
    await Promise.all([a, b]);

    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("tracks active and queued depth independently per conversation", async () => {
    let resolveA: () => void = () => {};
    const aGate = new Promise<void>((resolve) => {
      resolveA = resolve;
    });
    const a = chainInboundSessionTask("s1", () => aGate);
    const b = chainInboundSessionTask("s1", async () => undefined);

    expect(getInboundSessionQueueDepth("s1")).toBe(2);
    resolveA();
    await Promise.all([a, b]);
    await flushMicrotasks();
    expect(getInboundSessionQueueDepth("s1")).toBe(0);
  });

  it("runs independent queues in parallel (different keys)", async () => {
    let resolveA: () => void = () => {};
    let resolveB: () => void = () => {};
    const aGate = new Promise<void>((resolve) => {
      resolveA = resolve;
    });
    const bGate = new Promise<void>((resolve) => {
      resolveB = resolve;
    });
    const order: string[] = [];

    const a = chainInboundSessionTask("s1", async () => {
      order.push("a-start");
      await aGate;
      order.push("a-end");
    });
    const b = chainInboundSessionTask("s2", async () => {
      order.push("b-start");
      await bGate;
      order.push("b-end");
    });

    await Promise.resolve();
    await Promise.resolve();
    // Both started in parallel (different conversation keys).
    expect(order).toEqual(["a-start", "b-start"]);

    resolveA();
    resolveB();
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "b-start", "a-end", "b-end"]);
  });

  it("a failed task does NOT block the next queued task (rejection-safe tail)", async () => {
    const order: string[] = [];
    const boom = new Error("boom");

    const a = chainInboundSessionTask("s1", async () => {
      order.push("a");
      throw boom;
    });
    const b = chainInboundSessionTask("s1", async () => {
      order.push("b");
    });

    await expect(a).rejects.toBe(boom);
    await b;
    await flushMicrotasks();
    expect(order).toEqual(["a", "b"]);
    // After both settle the queue is clean.
    expect(isInboundSessionQueueBusy("s1")).toBe(false);
  });

  it("returns each task's own outcome to its caller", async () => {
    // The caller-visible promise propagates the task's own resolved value
    // (real tasks return void; this proves non-swallowing of outcomes).
    const result = await chainInboundSessionTask("s1", async () => 42);
    expect(result).toBe(42);
    await flushMicrotasks();
  });

  it("times out a waiting task without aborting the active task or running the expired work", async () => {
    vi.useFakeTimers();
    try {
      let resolveA: () => void = () => {};
      const aGate = new Promise<void>((resolve) => {
        resolveA = resolve;
      });
      const runB = vi.fn();
      const a = chainInboundSessionTask("s1", () => aGate);
      const b = chainInboundSessionTask("s1", async () => runB(), { maxQueueWaitMs: 1_000 });

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(b).rejects.toMatchObject({ name: "InboundSessionQueueWaitTimeoutError" });
      expect(runB).not.toHaveBeenCalled();
      expect(getInboundSessionQueueDepth("s1")).toBe(2);

      resolveA();
      await a;
      await flushMicrotasks();
      expect(runB).not.toHaveBeenCalled();
      expect(getInboundSessionQueueDepth("s1")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
