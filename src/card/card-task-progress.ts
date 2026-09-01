import {
  createDynamicAckReactionCorrelator,
  type DynamicAckReactionLogger,
  type RuntimeAgentEvent,
  type RuntimeEventsSurface,
} from "../ack-reaction/dynamic-ack-reaction-events";
import { getErrorMessage } from "../utils";

const DEFAULT_START_DELAY_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const OPTIMISTIC_RUN_ID_CAPTURE_WINDOW_MS = 5_000;

function resolveSafeStage(toolName: unknown): string {
  const name = typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
  if (["read", "view", "find", "list", "glob"].includes(name)) {
    return "正在检查文件";
  }
  if (["write", "edit", "patch", "apply_patch"].includes(name)) {
    return "正在应用修改";
  }
  if (["web_search", "search", "fetch", "open", "open_url"].includes(name)) {
    return "正在查询资料";
  }
  if (name.includes("browser")) {
    return "正在验证页面";
  }
  if (["bash", "exec", "process", "exec_command"].includes(name)) {
    return "正在执行检查";
  }
  if (name.includes("database") || name.includes("sql") || name.includes("query")) {
    return "正在查询数据";
  }
  return "正在处理任务";
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

function formatUpdatedAt(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function createCardTaskProgressController(params: {
  sessionKey: string;
  runtimeEvents?: RuntimeEventsSurface;
  updateProgress: (text: string) => Promise<void>;
  clearProgress: () => Promise<void>;
  startDelayMs?: number;
  heartbeatIntervalMs?: number;
  log?: DynamicAckReactionLogger;
}) {
  const startedAt = Date.now();
  let currentStage = "正在处理任务";
  let completedSteps = 0;
  let visible = false;
  let disposed = false;
  let updatePromise: Promise<void> = Promise.resolve();
  let heartbeatTimer: NodeJS.Timeout | undefined;
  const completedToolCalls = new Set<string>();
  const isCorrelatedEvent = createDynamicAckReactionCorrelator({
    sessionKey: params.sessionKey,
    enabled: true,
    createdAt: startedAt,
    optimisticCaptureWindowMs: OPTIMISTIC_RUN_ID_CAPTURE_WINDOW_MS,
    log: params.log,
  });

  const render = (): string => {
    const now = Date.now();
    return [
      "⏳ 任务处理中",
      `当前阶段：${currentStage}`,
      `已完成：${completedSteps} 步`,
      `已耗时：${formatElapsed(now - startedAt)}`,
      `更新：${formatUpdatedAt(now)}`,
    ].join("\n");
  };

  const ensureHeartbeat = () => {
    if (heartbeatTimer || disposed) {
      return;
    }
    heartbeatTimer = setInterval(() => {
      if (visible) {
        void queueUpdate();
      }
    }, params.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
  };

  const queueUpdate = () => {
    if (disposed) {
      return updatePromise;
    }
    visible = true;
    ensureHeartbeat();
    updatePromise = updatePromise
      .then(() => params.updateProgress(render()))
      .catch((error: unknown) => {
        params.log?.warn?.(`[DingTalk][TaskProgress] Card update failed: ${getErrorMessage(error)}`);
      });
    return updatePromise;
  };

  const handleAgentEvent = (event: unknown) => {
    if (disposed) {
      return;
    }
    const agentEvent = event as RuntimeAgentEvent | undefined;
    if (agentEvent?.stream === "lifecycle" && agentEvent.data?.phase === "start") {
      void isCorrelatedEvent(agentEvent);
      return;
    }
    if (agentEvent?.stream !== "tool" || !isCorrelatedEvent(agentEvent)) {
      return;
    }

    if (agentEvent.data?.phase === "start") {
      currentStage = resolveSafeStage(agentEvent.data?.name);
      void queueUpdate();
      return;
    }
    if (agentEvent.data?.phase === "end") {
      const toolCallId = agentEvent.data?.toolCallId?.trim();
      if (!toolCallId || !completedToolCalls.has(toolCallId)) {
        if (toolCallId) {
          completedToolCalls.add(toolCallId);
        }
        completedSteps += 1;
      }
      void queueUpdate();
    }
  };

  const unsubscribe = params.runtimeEvents?.onAgentEvent?.(handleAgentEvent) ?? (() => {});
  const startTimer = setTimeout(() => {
    void queueUpdate();
  }, params.startDelayMs ?? DEFAULT_START_DELAY_MS);

  return {
    async awaitDrain(): Promise<void> {
      await updatePromise.catch(() => undefined);
    },
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      clearTimeout(startTimer);
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      unsubscribe();
      await this.awaitDrain();
      if (visible) {
        await params.clearProgress();
      }
    },
  };
}
