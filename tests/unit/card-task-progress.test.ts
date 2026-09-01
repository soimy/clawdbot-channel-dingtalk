import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCardTaskProgressController } from "../../src/card/card-task-progress";

describe("card task progress", () => {
  let listener: ((event: unknown) => void) | undefined;
  const updateProgress = vi.fn().mockResolvedValue(undefined);
  const clearProgress = vi.fn().mockResolvedValue(undefined);
  const runtimeEvents = {
    onAgentEvent: vi.fn((nextListener: (event: unknown) => void) => {
      listener = nextListener;
      return vi.fn();
    }),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T04:00:00.000Z"));
    listener = undefined;
    updateProgress.mockClear();
    clearProgress.mockClear();
    runtimeEvents.onAgentEvent.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a safe stage for a correlated tool without rendering raw arguments", async () => {
    const controller = createCardTaskProgressController({
      sessionKey: "s1",
      runtimeEvents,
      updateProgress,
      clearProgress,
    });

    listener?.({ stream: "lifecycle", runId: "run-1", sessionKey: "s1", data: { phase: "start" } });
    listener?.({
      stream: "tool",
      runId: "run-1",
      sessionKey: "s1",
      data: {
        phase: "start",
        name: "exec",
        toolCallId: "tool-1",
        args: { cmd: "curl -H 'Authorization: Bearer secret-token' https://example.com" },
      },
    });
    await controller.awaitDrain();

    const rendered = String(updateProgress.mock.calls.at(-1)?.[0] ?? "");
    expect(rendered).toContain("当前阶段：正在执行检查");
    expect(rendered).toContain("已完成：0 步");
    expect(rendered).not.toContain("curl");
    expect(rendered).not.toContain("secret-token");
  });

  it("counts completed tools and changes to the next concise stage", async () => {
    const controller = createCardTaskProgressController({
      sessionKey: "s1",
      runtimeEvents,
      updateProgress,
      clearProgress,
    });

    listener?.({ stream: "lifecycle", runId: "run-1", sessionKey: "s1", data: { phase: "start" } });
    listener?.({
      stream: "tool",
      runId: "run-1",
      data: { phase: "start", name: "read", toolCallId: "tool-1" },
    });
    listener?.({
      stream: "tool",
      runId: "run-1",
      data: { phase: "end", name: "read", toolCallId: "tool-1" },
    });
    listener?.({
      stream: "tool",
      runId: "run-1",
      data: { phase: "start", name: "web_search", toolCallId: "tool-2" },
    });
    await controller.awaitDrain();

    const rendered = String(updateProgress.mock.calls.at(-1)?.[0] ?? "");
    expect(rendered).toContain("当前阶段：正在查询资料");
    expect(rendered).toContain("已完成：1 步");
  });

  it("starts after ten seconds and refreshes a heartbeat every thirty seconds", async () => {
    const controller = createCardTaskProgressController({
      sessionKey: "s1",
      runtimeEvents,
      updateProgress,
      clearProgress,
    });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(updateProgress).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await controller.awaitDrain();
    expect(updateProgress).toHaveBeenCalledTimes(1);
    expect(String(updateProgress.mock.calls[0]?.[0])).toContain("当前阶段：正在处理任务");

    await vi.advanceTimersByTimeAsync(30_000);
    await controller.awaitDrain();
    expect(updateProgress).toHaveBeenCalledTimes(2);
    expect(String(updateProgress.mock.calls[1]?.[0])).toContain("已耗时：40 秒");

    await vi.advanceTimersByTimeAsync(30_000);
    await controller.awaitDrain();
    expect(updateProgress).toHaveBeenCalledTimes(3);
    expect(String(updateProgress.mock.calls[2]?.[0])).toContain("已耗时：1 分 10 秒");
  });

  it("unsubscribes and clears progress when disposed", async () => {
    const unsubscribe = vi.fn();
    runtimeEvents.onAgentEvent.mockImplementationOnce((nextListener) => {
      listener = nextListener;
      return unsubscribe;
    });
    const controller = createCardTaskProgressController({
      sessionKey: "s1",
      runtimeEvents,
      updateProgress,
      clearProgress,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await controller.dispose();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(clearProgress).toHaveBeenCalledOnce();
  });
});
