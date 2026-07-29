import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { CardCallbackAnalysis } from "../card-callback-service";
import type { DingTalkConfig, Logger } from "../types";
import { handleDingTalkAskUserCardCallback } from "./ask-user-question";
import { resolveCardRun } from "./card-run-registry";
import { stopCardRun } from "./card-stop-handler";

export interface CardActionResult {
  handled: boolean;
}

export async function handleCardAction(params: {
  payload: unknown;
  analysis: CardCallbackAnalysis;
  cfg: OpenClawConfig;
  accountId: string;
  storePath?: string;
  config: DingTalkConfig;
  log?: Logger;
}): Promise<CardActionResult> {
  const askUserResult = await handleDingTalkAskUserCardCallback({
    payload: params.payload,
    cfg: params.cfg,
    accountId: params.accountId,
    storePath: params.storePath,
    config: params.config,
    clickerUserId: params.analysis.userId,
    log: params.log,
  });
  if (askUserResult.handled) {
    return askUserResult;
  }

  if (params.analysis.actionId !== "btn_stop") {
    return { handled: false };
  }

  const outTrackId = params.analysis.outTrackId;
  if (!outTrackId) {
    params.log?.warn?.(
      `[${params.accountId}] [DingTalk][CardStop] stop callback missing outTrackId — cannot route stop request`,
    );
    return { handled: false };
  }

  const clickerUserId = params.analysis.userId;
  const record = resolveCardRun(outTrackId);
  if (!record?.ownerUserId) {
    params.log?.warn?.(
      `[${params.accountId}] [DingTalk][CardStop] security rejection: missing owner binding outTrackId=${outTrackId}`,
    );
    return { handled: true };
  }
  if (!clickerUserId || record.ownerUserId !== clickerUserId) {
    params.log?.info?.(
      `[${params.accountId}] [DingTalk][CardStop] rejected: clicker=${clickerUserId ?? "unknown"} owner=${record.ownerUserId}`,
    );
    return { handled: true };
  }

  const result = await stopCardRun({
    cfg: params.cfg,
    accountId: params.accountId,
    outTrackId,
    config: params.config,
    clickerUserId,
    log: params.log,
  });
  if (!result.ok) {
    params.log?.warn?.(
      `[${params.accountId}] [DingTalk][CardStop] stop failed status=${result.status} reason=${result.reason ?? "unknown"}`,
    );
  } else {
    params.log?.info?.(
      `[${params.accountId}] [DingTalk][CardStop] stop succeeded outTrackId=${outTrackId}`,
    );
  }

  return { handled: true };
}
