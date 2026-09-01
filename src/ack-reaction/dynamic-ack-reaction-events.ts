import { getErrorMessage } from "../utils";

export type DynamicAckReactionLogger = {
  debug?: (msg: string) => void;
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
};

export type RuntimeAgentEvent = {
  stream?: string;
  runId?: string;
  sessionKey?: string;
  data?: {
    phase?: string;
    name?: string;
    args?: unknown;
    runId?: string;
    sessionKey?: string;
    toolCallId?: string;
    meta?: {
      runId?: string;
      sessionKey?: string;
    } | null;
  };
};

export type RuntimeEventsSurface = {
  onAgentEvent?: (listener: (event: unknown) => void) => () => void;
};

export function createRuntimeEventsFanout(
  upstream: RuntimeEventsSurface | undefined,
): RuntimeEventsSurface {
  const listeners = new Set<(event: unknown) => void>();
  let unsubscribeUpstream: (() => void) | undefined;

  const ensureUpstreamSubscription = () => {
    if (unsubscribeUpstream || !upstream?.onAgentEvent) {
      return;
    }
    unsubscribeUpstream = upstream.onAgentEvent((event: unknown) => {
      const currentListeners = Array.from(listeners);
      for (const listener of currentListeners) {
        listener(event);
      }
    });
  };

  return {
    onAgentEvent(listener: (event: unknown) => void) {
      listeners.add(listener);
      ensureUpstreamSubscription();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && unsubscribeUpstream) {
          unsubscribeUpstream();
          unsubscribeUpstream = undefined;
        }
      };
    },
  };
}

function firstTrimmedString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function getEventRunId(event: RuntimeAgentEvent | undefined): string | undefined {
  return firstTrimmedString(event?.runId, event?.data?.runId, event?.data?.meta?.runId);
}

export function getEventSessionKey(event: RuntimeAgentEvent | undefined): string | undefined {
  return firstTrimmedString(
    event?.sessionKey,
    event?.data?.sessionKey,
    event?.data?.meta?.sessionKey,
  );
}

export function describeEvent(event: RuntimeAgentEvent | undefined): string {
  const stream = firstTrimmedString(event?.stream) || "-";
  const phase = firstTrimmedString(event?.data?.phase) || "-";
  const toolName = firstTrimmedString(event?.data?.name) || "-";
  const toolCallId = firstTrimmedString(event?.data?.toolCallId) || "-";
  return (
    `stream=${stream} phase=${phase} runId=${getEventRunId(event) || "-"} ` +
    `sessionKey=${getEventSessionKey(event) || "-"} toolCallId=${toolCallId} toolName=${toolName}`
  );
}

export function createDynamicAckReactionCorrelator(params: {
  sessionKey: string;
  enabled: boolean;
  createdAt: number;
  optimisticCaptureWindowMs: number;
  log?: DynamicAckReactionLogger;
}) {
  let activeRunId: string | undefined;
  let correlationUnavailableLogged = false;
  let optimisticCaptureCount = 0;

  return (event: RuntimeAgentEvent | undefined): boolean => {
    const eventRunId = getEventRunId(event);
    const eventSessionKey = getEventSessionKey(event);
    const eventStream = firstTrimmedString(event?.stream) || "";
    const eventPhase = firstTrimmedString(event?.data?.phase) || "";

    if (activeRunId) {
      const matched = eventRunId === activeRunId;
      params.log?.debug?.(
        `[DingTalk] Dynamic reaction correlation by runId matched=${matched} activeRunId=${activeRunId} ` +
          `eventRunId=${eventRunId || "-"} eventSessionKey=${eventSessionKey || "-"}`,
      );
      return matched;
    }

    if (eventSessionKey === params.sessionKey) {
      if (eventRunId) {
        activeRunId = eventRunId;
        params.log?.debug?.(
          `[DingTalk] Dynamic reaction captured active runId=${activeRunId} from sessionKey=${params.sessionKey}`,
        );
      } else {
        params.log?.debug?.(
          `[DingTalk] Dynamic reaction correlated by sessionKey=${params.sessionKey} without runId`,
        );
      }
      return true;
    }

    if (
      optimisticCaptureCount === 0 &&
      eventStream === "lifecycle" &&
      eventPhase === "start" &&
      eventRunId &&
      !eventSessionKey &&
      Date.now() - params.createdAt <= params.optimisticCaptureWindowMs
    ) {
      optimisticCaptureCount += 1;
      activeRunId = eventRunId;
      params.log?.debug?.(
        `[DingTalk] Dynamic reaction optimistically captured active runId=${activeRunId} ` +
          `from first lifecycle event without sessionKey windowMs=${params.optimisticCaptureWindowMs}`,
      );
      return true;
    }

    if (!correlationUnavailableLogged && params.enabled) {
      correlationUnavailableLogged = true;
      params.log?.debug?.(
        `[DingTalk] Dynamic reaction ignored uncorrelated agent events; ` +
          `reason=${getErrorMessage(eventRunId || eventSessionKey || "waiting for sessionKey/runId match")}`,
      );
    }
    return false;
  };
}
