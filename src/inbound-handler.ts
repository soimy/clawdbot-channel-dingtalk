import fs from "node:fs";
import * as path from "node:path";
import { isAbortRequestText, isBtwRequestText } from "openclaw/plugin-sdk/reply-runtime";
import { parseInlineDirectives } from "openclaw/plugin-sdk/text-runtime";
import { normalizeAllowFrom, isSenderAllowed, resolveGroupAccess } from "./access-control";
import { classifyAckReactionEmoji } from "./ack-reaction-classifier";
import { attachNativeAckReaction } from "./ack-reaction-service";
import { createDynamicAckReactionController } from "./ack-reaction/dynamic-ack-reaction-controller";
import { getAccessToken } from "./auth";
import {
  createAICard,
  commitAICardBlocks,
  isCardInTerminalState,
  recallAICardMessage,
} from "./card-service";
import {
  invalidateAskUserQuestionsForScope,
  syncInvalidatedAskUserQuestionCards,
} from "./card/ask-user-question";
import {
  getDingTalkQuestionContext,
  withDingTalkQuestionContext,
} from "./card/ask-user-question-context";
import { isCardRunStopRequested, registerCardRun, removeCardRun } from "./card/card-run-registry";
import { renderStatusLine } from "./card/statusline-renderer";
import { resolveConfiguredTaskModelMetadata } from "./card/task-model-metadata";
import { dispatchDingTalkCardStopCommand } from "./command/card-stop-command";
import { handleInboundCommandDispatch } from "./command/inbound-command-dispatch-service";
import {
  resolveAckReactionSetting,
  resolveGroupConfig,
  resolveRelativePath,
  resolveRobotCode,
} from "./config";
import { buildLearningContextBlock, isLearningEnabled } from "./feedback-learning-service";
import axios from "./http-client";
import { setCurrentLogger } from "./logger-context";
import { prepareMediaInput, resolveOutboundMediaType } from "./media-utils";
import {
  DEFAULT_MEDIA_CONTEXT_TTL_MS,
  DEFAULT_MESSAGE_CONTEXT_TTL_DAYS,
  upsertInboundMessageContext,
} from "./message-context-store";
import { extractMessageContent } from "./message-utils";
import { extractAttachmentText } from "./messaging/attachment-text-extractor";
import { deliverBtwReply, stripLeadingMentions } from "./messaging/btw-deliver";
import { resolveQuotedRuntimeContext } from "./messaging/quoted-context";
import {
  downloadGroupFile,
  getUnionIdByStaffId,
  resolveQuotedFile,
} from "./messaging/quoted-file-service";
import {
  buildInboundQuotedRef,
  createReplyQuotedRef,
  resolveQuotedRecord,
} from "./messaging/quoted-ref";
import { registerPeerId } from "./peer-id-registry";
import {
  clearProactiveRiskObservationsForTest,
  getProactiveRiskObservationForAny,
} from "./proactive-risk-registry";
import { createReplyStrategy } from "./reply-strategy";
import type { DeliverPayload } from "./reply-strategy-types";
import { getDingTalkRuntime } from "./runtime";
import { sendBySession, sendMessage, sendProactiveMedia } from "./send-service";
import { acquireSessionLock } from "./session-lock";
import {
  clearSessionPeerOverride,
  getSessionPeerOverride,
  setSessionPeerOverride,
} from "./session-peer-store";
import { resolveDingTalkSessionPeer } from "./session-routing";
import { getSessionState, initSessionState } from "./session-state";
import { getAgentDisplayName } from "./targeting/agent-name-matcher";
import {
  buildAgentSessionKey,
  dispatchSubAgents,
  resolveMessageTarget,
  sendUnmatchedAgentNotice,
} from "./targeting/agent-routing";
import { formatGroupMembers, noteGroupMember } from "./targeting/group-members-store";
import {
  upsertObservedGroupTarget,
  upsertObservedUserTarget,
} from "./targeting/target-directory-store";
import { AICardStatus } from "./types";
import type {
  DingTalkConfig,
  HandleDingTalkMessageParams,
  Logger,
  MediaFile,
  ResolvedDingTalkRoute,
} from "./types";
import {
  formatDingTalkErrorPayloadLog,
  getErrorMessage,
  getErrorResponseData,
  maskSensitiveData,
  parseBooleanLike,
} from "./utils";

const DEFAULT_PROACTIVE_HINT_COOLDOWN_HOURS = 24;
const MIN_THINKING_REACTION_VISIBLE_MS = 1200;
const MAX_DYNAMIC_ACK_DISPOSE_WAIT_MS = 500;
const ATTACHMENT_TEXT_PREFIX = "[附件内容摘录]";
const MEDIA_DIRECTIVE_PREFIX = "MEDIA:";
const STANDALONE_MEDIA_PATH_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".bmp",
  ".ogg",
  ".amr",
  ".mp3",
  ".wav",
  ".mp4",
  ".avi",
  ".mov",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip",
  ".pdf",
  ".rar",
]);
const proactiveHintLastSentAt = new Map<string, number>();
const sessionReasoningLevelCache = new Map<
  string,
  {
    updatedAt?: number;
    reasoningLevel?: string;
  }
>();
// Prevent concurrent card creation for the same conversation.
// createAICard runs before acquireSessionLock (for immediate visual feedback),
// but two inbound messages can race past each other's card-run registration.
// This synchronous Set closes that window because JavaScript check-and-set here
// is atomic from the caller's perspective.
const cardCreationInFlight = new Set<string>();
type ReplyMode = "card" | "markdown";

function resolveQuotedContextAllowFrom(
  config: DingTalkConfig,
  groupId: string,
): string[] | undefined {
  const groupConfig = resolveGroupConfig(config, groupId);
  return groupConfig?.groupAllowFrom ?? config.groupAllowFrom;
}

function resolveQuotedVisibilitySenderId(params: {
  quotedSenderId?: string;
  currentSenderId: string;
  currentSenderOriginalId: string;
}): string | undefined {
  const quotedSenderId = (params.quotedSenderId || "").trim();
  if (!quotedSenderId) {
    return undefined;
  }
  if (quotedSenderId === params.currentSenderOriginalId) {
    return params.currentSenderId;
  }
  return quotedSenderId;
}

function filterQuotedRuntimeContext(params: {
  context: ReturnType<typeof resolveQuotedRuntimeContext>;
  config: DingTalkConfig;
  isDirect: boolean;
  groupId: string;
  quotedSenderId?: string;
  currentSenderId: string;
  currentSenderOriginalId: string;
}): ReturnType<typeof resolveQuotedRuntimeContext> {
  const {
    context,
    config,
    isDirect,
    groupId,
    quotedSenderId,
    currentSenderId,
    currentSenderOriginalId,
  } = params;
  if (!context || isDirect) {
    return context;
  }

  const mode = config.contextVisibility || "all";
  if (mode === "all") {
    return context;
  }

  const allow = normalizeAllowFrom(resolveQuotedContextAllowFrom(config, groupId));
  const senderId = resolveQuotedVisibilitySenderId({
    quotedSenderId,
    currentSenderId,
    currentSenderOriginalId,
  });
  const senderAllowed =
    allow.hasEntries && !!senderId ? isSenderAllowed({ allow, senderId }) : false;

  if (senderAllowed) {
    return context;
  }
  if (mode === "allowlist_quote") {
    return {
      ...context,
      untrustedContext: undefined,
    };
  }
  return null;
}

function readSessionReasoningLevel(params: {
  storePath?: string;
  sessionKey: string;
  sessionUpdatedAt?: number;
  log?: Logger;
}): string | undefined {
  if (!params.storePath || !params.sessionKey) {
    return undefined;
  }
  const cacheKey = `${params.storePath}:${params.sessionKey}`;
  const cached = sessionReasoningLevelCache.get(cacheKey);
  if (
    cached &&
    params.sessionUpdatedAt !== undefined &&
    cached.updatedAt === params.sessionUpdatedAt
  ) {
    return cached.reasoningLevel;
  }
  try {
    const raw = fs.readFileSync(params.storePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, { reasoningLevel?: unknown }>;
    const value = parsed?.[params.sessionKey]?.reasoningLevel;
    const reasoningLevel = typeof value === "string" ? value.trim().toLowerCase() : undefined;
    sessionReasoningLevelCache.set(cacheKey, {
      updatedAt: params.sessionUpdatedAt,
      reasoningLevel,
    });
    return reasoningLevel;
  } catch (err: unknown) {
    params.log?.debug?.(
      `[DingTalk][Session] Failed to read session reasoning level from ${params.storePath}: ${getErrorMessage(err)}`,
    );
    return undefined;
  }
}

function shouldDisableBlockStreamingForReplyMode(params: {
  replyMode: ReplyMode;
  reasoningLevel?: string;
  sessionKey: string;
  log?: Logger;
}): boolean {
  if (params.replyMode === "markdown") {
    const shouldDisable = params.reasoningLevel === "on" || params.reasoningLevel === "stream";
    if (shouldDisable) {
      params.log?.debug?.(
        `[DingTalk][Markdown] Disable block streaming for reasoningLevel=${params.reasoningLevel} sessionKey=${params.sessionKey}`,
      );
    }
    return shouldDisable;
  }

  const shouldDisable = params.reasoningLevel !== "on";
  if (!shouldDisable) {
    params.log?.debug?.(
      `[DingTalk][Card] Enable block streaming for reasoningLevel=${params.reasoningLevel} sessionKey=${params.sessionKey}`,
    );
  }
  return shouldDisable;
}

function resolveLegacyCardStreamReasoningForInternalUse(params: {
  cfg: HandleDingTalkMessageParams["cfg"];
  accountId: string;
}): boolean | undefined {
  const dingtalk = (params.cfg?.channels?.dingtalk ?? null) as
    | (Record<string, unknown> & {
        cardStreamReasoning?: unknown;
        accounts?: Record<string, Record<string, unknown> | undefined>;
      })
    | null;
  if (!dingtalk) {
    return undefined;
  }
  const accountConfig = params.accountId ? dingtalk.accounts?.[params.accountId] : undefined;
  if (typeof accountConfig?.cardStreamReasoning === "boolean") {
    return accountConfig.cardStreamReasoning;
  }
  if (typeof dingtalk.cardStreamReasoning === "boolean") {
    return dingtalk.cardStreamReasoning;
  }
  return undefined;
}

function resolvePinnedMainDmOwner(params: {
  dmScope?: string;
  allowFrom?: string[];
}): string | null {
  if ((params.dmScope ?? "main") !== "main") {
    return null;
  }
  const allow = normalizeAllowFrom(params.allowFrom);
  if (allow.hasWildcard) {
    return null;
  }
  return allow.entries.length === 1 ? allow.entries[0] : null;
}

function ttlDaysToMs(ttlDays: number | undefined): number | undefined {
  if (typeof ttlDays !== "number" || !Number.isFinite(ttlDays) || ttlDays <= 0) {
    return undefined;
  }
  return ttlDays * 24 * 60 * 60 * 1000;
}

async function waitForDynamicAckDispose(params: {
  dispose: () => Promise<void>;
  log?: { debug?: (message: string) => void; warn?: (message: string) => void };
  sessionKey: string;
}): Promise<void> {
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const disposePromise = params.dispose().catch((err: unknown) => {
    params.log?.warn?.(
      `[DingTalk] Dynamic ack reaction cleanup failed for session ${params.sessionKey}: ${getErrorMessage(err)}`,
    );
  });

  try {
    await Promise.race([
      disposePromise,
      new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          resolve();
        }, MAX_DYNAMIC_ACK_DISPOSE_WAIT_MS);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }

  if (timedOut) {
    params.log?.debug?.(
      `[DingTalk] Dynamic ack reaction cleanup timed out after ${MAX_DYNAMIC_ACK_DISPOSE_WAIT_MS}ms; releasing session lock for ${params.sessionKey}`,
    );
  }
}

export function resetProactivePermissionHintStateForTest(): void {
  proactiveHintLastSentAt.clear();
  clearProactiveRiskObservationsForTest();
}

function shouldSendProactivePermissionHint(params: {
  isDirect: boolean;
  accountId: string;
  senderId: string;
  senderOriginalId?: string;
  senderStaffId?: string;
  config: DingTalkConfig;
  nowMs: number;
}): boolean {
  if (!params.isDirect) {
    return false;
  }

  const hintConfig = params.config.proactivePermissionHint;
  if (hintConfig?.enabled === false) {
    return false;
  }

  const targetId = (params.senderId || "").trim();
  if (!targetId) {
    return false;
  }

  const riskTargets = [params.senderId, params.senderOriginalId, params.senderStaffId]
    .map((id) => (id || "").trim())
    .filter((id, index, arr) => Boolean(id) && arr.indexOf(id) === index);
  if (riskTargets.length === 0) {
    return false;
  }

  const riskObservation = getProactiveRiskObservationForAny(
    params.accountId,
    riskTargets,
    params.nowMs,
  );
  if (!riskObservation || riskObservation.source !== "proactive-api") {
    return false;
  }

  const cooldownHours =
    hintConfig?.cooldownHours && hintConfig.cooldownHours > 0
      ? hintConfig.cooldownHours
      : DEFAULT_PROACTIVE_HINT_COOLDOWN_HOURS;
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  const key = `${params.accountId}:${targetId}`;
  const lastSentAt = proactiveHintLastSentAt.get(key) || 0;
  if (params.nowMs - lastSentAt < cooldownMs) {
    return false;
  }

  proactiveHintLastSentAt.set(key, params.nowMs);
  return true;
}

function sanitizeGroupPromptName(value?: string): string {
  return (value || "")
    .replace(/[\r\n,=]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildGroupTurnContextPrompt(params: {
  conversationId: string;
  senderDingtalkId: string;
  senderName?: string;
}): string {
  const sanitizedSenderName = sanitizeGroupPromptName(params.senderName) || "Unknown";
  return [
    "Current DingTalk group turn context:",
    `- conversationId: ${params.conversationId}`,
    `- senderDingtalkId: ${params.senderDingtalkId}`,
    `- senderName: ${sanitizedSenderName}`,
    "Treat senderDingtalkId and senderName as the authoritative sender for this turn. Do not guess the current sender from GroupMembers.",
  ].join("\n");
}

type ReplyStreamPayload = {
  text?: string;
  isError?: boolean;
  isReasoning?: boolean;
  mediaUrl?: string;
  mediaUrls?: string[];
};

type ReplyChunkInfo = {
  kind?: string;
};

const INBOUND_MEDIA_DOWNLOAD_TIMEOUT_MS = 15_000;
const DINGTALK_API_HOST = "api.dingtalk.com";

/**
 * Download DingTalk media file via runtime media service (sandbox-compatible).
 * Files are stored in the global media inbound directory.
 */
export async function downloadMedia(
  config: DingTalkConfig,
  downloadCode: string,
  log?: any,
  originalFilename?: string,
): Promise<MediaFile | null> {
  const rt = getDingTalkRuntime();
  let downloadUrl: string | undefined;
  let requestStage = "auth";
  let requestHost = DINGTALK_API_HOST;
  const formatAxiosErrorData = (value: unknown): string | undefined => {
    if (value === null || value === undefined) {
      return undefined;
    }
    if (Buffer.isBuffer(value)) {
      return `<buffer ${value.length} bytes>`;
    }
    if (value instanceof ArrayBuffer) {
      return `<arraybuffer ${value.byteLength} bytes>`;
    }
    if (typeof value === "string") {
      return value.length > 500 ? `${value.slice(0, 500)}…` : value;
    }
    try {
      return JSON.stringify(maskSensitiveData(value));
    } catch {
      return `[unstringifiable ${typeof value}]`;
    }
  };

  if (!downloadCode) {
    log?.error?.("[DingTalk] downloadMedia requires downloadCode to be provided.");
    return null;
  }
  const robotCode = resolveRobotCode(config);
  if (!robotCode) {
    if (log?.error) {
      log.error("[DingTalk] downloadMedia requires clientId to be configured.");
    }
    return null;
  }
  try {
    requestStage = "auth";
    requestHost = DINGTALK_API_HOST;
    const token = await getAccessToken(config, log);
    requestStage = "exchange";
    requestHost = DINGTALK_API_HOST;
    const response = await axios.post(
      "https://api.dingtalk.com/v1.0/robot/messageFiles/download",
      { downloadCode, robotCode },
      { headers: { "x-acs-dingtalk-access-token": token } },
    );
    const payload = response.data as Record<string, any>;
    downloadUrl = payload?.downloadUrl ?? payload?.data?.downloadUrl;
    if (!downloadUrl) {
      const payloadDetail = formatAxiosErrorData(payload);
      log?.error?.(
        `[DingTalk] downloadMedia missing downloadUrl. payload=${payloadDetail ?? "unknown"}`,
      );
      return null;
    }
    requestStage = "download";
    requestHost = (() => {
      try {
        return new URL(downloadUrl).host || "unknown";
      } catch {
        return "unknown";
      }
    })();
    const mediaResponse = await axios.get(downloadUrl, {
      responseType: "arraybuffer",
      timeout: INBOUND_MEDIA_DOWNLOAD_TIMEOUT_MS,
    });
    const contentType = mediaResponse.headers["content-type"] || "application/octet-stream";
    const buffer = Buffer.from(mediaResponse.data as ArrayBuffer);

    const maxBytes =
      config.mediaMaxMb && config.mediaMaxMb > 0 ? config.mediaMaxMb * 1024 * 1024 : undefined;
    const saved = await rt.channel.media.saveMediaBuffer(
      buffer,
      contentType,
      "inbound",
      maxBytes,
      originalFilename,
    );
    log?.debug?.(`[DingTalk] Media saved: ${saved.path}`);
    return { path: saved.path, mimeType: saved.contentType ?? contentType };
  } catch (err: any) {
    if (log?.error) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const statusText = err.response?.statusText;
        const dataDetail = formatAxiosErrorData(err.response?.data);
        const code = err.code ? ` code=${err.code}` : "";
        const statusLabel = status ? ` status=${status}${statusText ? ` ${statusText}` : ""}` : "";
        log.error(
          `[DingTalk] Failed to download media: stage=${requestStage} host=${requestHost}${statusLabel}${code} message=${err.message}`,
        );
        if (err.response?.data !== undefined) {
          log.error(formatDingTalkErrorPayloadLog("inbound.downloadMedia", err.response.data));
        } else if (dataDetail) {
          log.error(`[DingTalk] downloadMedia response data: ${dataDetail}`);
        }
      } else {
        log.error(
          `[DingTalk] Failed to download media: stage=${requestStage} host=${requestHost} message=${err.message}`,
        );
      }
    }
    return null;
  }
}

export async function handleDingTalkMessage(params: HandleDingTalkMessageParams): Promise<void> {
  // Keep context creation inside this public inbound entry. Ask-user synthetic
  // reinjections call handleDingTalkMessage directly, so moving this wrapper to
  // gateway callbacks would lose per-message isolation for reinjected answers.
  return withDingTalkQuestionContext(
    {
      cfg: params.cfg,
      accountId: params.accountId,
      data: params.data,
      sessionWebhook: params.sessionWebhook,
      log: params.log,
      dingtalkConfig: params.dingtalkConfig,
    },
    () => handleDingTalkMessageInner(params),
  );
}

async function handleDingTalkMessageInner(params: HandleDingTalkMessageParams): Promise<void> {
  const {
    cfg,
    accountId,
    data,
    sessionWebhook,
    log,
    dingtalkConfig,
    inboundOrigin = "stream",
    routeOverride,
    subAgentOptions,
    preDownloadedMedia,
  } = params;
  const rt = getDingTalkRuntime();

  // Save logger globally so shared services can log consistently without threading log everywhere.
  setCurrentLogger(log, accountId);

  log?.debug?.("[DingTalk] Full Inbound Data: " + JSON.stringify(maskSensitiveData(data)));

  // 1) Ignore self messages from bot.
  if (data.senderId === data.chatbotUserId || data.senderStaffId === data.chatbotUserId) {
    log?.debug?.("[DingTalk] Ignoring robot self-message");
    return;
  }

  // Shallow copy: only .text is reassigned below; nested arrays (atMentions, mediaTypes) are read-only downstream.
  const extractedContent = { ...extractMessageContent(data) };
  if (!extractedContent.text) {
    return;
  }

  // Preserve raw inbound text before any rewriting (e.g., sub-agent context hint)
  // for use in card quoteContent which should show the user's original message.
  const rawInboundText = extractedContent.text.trim();

  // Add context hint for sub-agent content mode, stripping quoted prefix to avoid protocol noise
  // in agent context. Skipped for targeted slash commands (`commandText` set): the hint would
  // pollute RawBody, and the command never reaches the agent's LLM anyway.
  if (subAgentOptions && !subAgentOptions.commandText) {
    const cleanText = extractedContent.text.replace(/^\[引用[^\]]*\]\s*/, "");
    const contextHint = `[你被 @ 为"${subAgentOptions.matchedName}"]\n\n`;
    extractedContent.text = contextHint + cleanText;
  }

  const isDirect = data.conversationType === "1";
  const isGroup = !isDirect;
  const senderOriginalId = (data.senderId || "").trim();
  const senderStaffId = (data.senderStaffId || "").trim();
  const senderId = senderStaffId || senderOriginalId;
  const senderName = data.senderNick || "Unknown";
  const groupId = data.conversationId;
  const groupName = data.conversationTitle || "Group";

  // Register original peer IDs to preserve case-sensitive DingTalk conversation IDs.
  if (groupId) {
    registerPeerId(groupId);
  }

  if (
    shouldSendProactivePermissionHint({
      isDirect,
      accountId,
      senderId,
      senderOriginalId,
      senderStaffId,
      config: dingtalkConfig,
      nowMs: Date.now(),
    })
  ) {
    try {
      await sendBySession(
        dingtalkConfig,
        sessionWebhook,
        "⚠️ 主动推送可能失败\n\n检测到该用户最近一次主动发送调用返回了权限或目标不可达错误。当前会话回复仍可正常使用，但定时/主动发送可能失败。\n\n建议：\n1) 在钉钉开放平台确认应用已申请并获得主动发送相关权限\n2) 确认目标用户属于当前企业并在应用可见范围内\n3) 使用相同账号进行一次主动发送验证并检查错误码详情",
        { log },
      );
    } catch (err: any) {
      log?.debug?.(`[DingTalk] Failed to send proactive permission hint: ${err.message}`);
      if (err?.response?.data !== undefined) {
        log?.debug?.(
          formatDingTalkErrorPayloadLog("inbound.proactivePermissionHint", err.response.data),
        );
      }
    }
  }
  if (senderId) {
    registerPeerId(senderId);
  }

  // 2) Authorization guard (DM/group policy).
  let commandAuthorized = true;
  if (isDirect) {
    const dmPolicy = dingtalkConfig.dmPolicy || "open";
    const allowFrom = dingtalkConfig.allowFrom || [];

    if (dmPolicy === "allowlist") {
      const normalizedAllowFrom = normalizeAllowFrom(allowFrom);
      const isAllowed = isSenderAllowed({ allow: normalizedAllowFrom, senderId });

      if (!isAllowed) {
        log?.debug?.(
          `[DingTalk] DM blocked: senderId=${senderId} not in allowlist (dmPolicy=allowlist)`,
        );
        try {
          await sendBySession(
            dingtalkConfig,
            sessionWebhook,
            `⛔ 访问受限\n\n您的用户ID：\`${senderId}\`\n\n请联系管理员将此ID添加到允许列表中。`,
            { log },
          );
        } catch (err: any) {
          log?.debug?.(`[DingTalk] Failed to send access denied message: ${err.message}`);
          if (err?.response?.data !== undefined) {
            log?.debug?.(
              formatDingTalkErrorPayloadLog("inbound.accessDeniedReply", err.response.data),
            );
          }
        }

        return;
      }

      log?.debug?.(`[DingTalk] DM authorized: senderId=${senderId} in allowlist`);
    } else if (dmPolicy === "pairing") {
      // SDK pairing flow performs actual authorization checks.
      commandAuthorized = true;
    } else {
      commandAuthorized = true;
    }
  } else {
    const groupAccess = resolveGroupAccess({
      groupPolicy: dingtalkConfig.groupPolicy || "open",
      groupId,
      senderId,
      groups: dingtalkConfig.groups,
      groupAllowFrom: dingtalkConfig.groupAllowFrom,
      allowFrom: dingtalkConfig.allowFrom,
    });

    if (groupAccess.legacyFallback) {
      log?.info?.(
        `[DingTalk] DEPRECATED: groupPolicy=allowlist is using "allowFrom" for group access control. ` +
          `Please migrate to "groups" (group ID allowlist) or "groupAllowFrom" (sender allowlist).`,
      );
    }

    if (!groupAccess.allowed) {
      if (groupAccess.reason === "disabled") {
        log?.debug?.(
          `[DingTalk] Group disabled: all group messages dropped (groupPolicy=disabled)`,
        );
        return;
      }

      const denyMessage =
        groupAccess.reason === "sender_not_allowed"
          ? `⛔ 访问受限\n\n您的用户ID：\`${senderId}\`\n\n请联系管理员将此ID添加到群聊允许列表中。`
          : `⛔ 访问受限\n\n您的群聊ID：\`${groupId}\`\n\n请联系管理员将此ID添加到允许列表中。`;

      log?.debug?.(
        `[DingTalk] Group blocked: conversationId=${groupId} senderId=${senderId} reason=${groupAccess.reason}`,
      );

      try {
        await sendBySession(dingtalkConfig, sessionWebhook, denyMessage, {
          log,
          atUserId: senderId,
        });
      } catch (err: any) {
        log?.debug?.(`[DingTalk] Failed to send group access denied message: ${err.message}`);
        if (err?.response?.data !== undefined) {
          log?.debug?.(
            formatDingTalkErrorPayloadLog("inbound.groupAccessDeniedReply", err.response.data),
          );
        }
      }

      return;
    }

    log?.debug?.(`[DingTalk] Group authorized: conversationId=${groupId} senderId=${senderId}`);
  }

  // Calculate account store path and session peer (for session alias feature)
  const accountStorePath = rt.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: accountId,
  });
  try {
    if (!isDirect && groupId) {
      upsertObservedGroupTarget({
        storePath: accountStorePath,
        accountId,
        conversationId: groupId,
        title: groupName,
        seenAt: data.createAt,
      });
    }
    if (senderId || senderOriginalId) {
      upsertObservedUserTarget({
        storePath: accountStorePath,
        accountId,
        senderId: senderOriginalId || senderId,
        staffId: senderStaffId || undefined,
        displayName: senderName,
        conversationId: groupId,
        seenAt: data.createAt,
      });
    }
  } catch (err) {
    log?.warn?.(
      `[DingTalk] Target directory observe failed: accountId=${accountId} groupId=${groupId || "-"} senderId=${senderOriginalId || senderId || "-"} storePath=${accountStorePath || "-"} error=${String(err)}`,
    );
  }
  const currentSessionSourceKind = isDirect ? "direct" : "group";
  const currentSessionSourceId = isDirect ? senderId : groupId;
  const peerIdOverride = getSessionPeerOverride({
    storePath: accountStorePath,
    accountId,
    sourceKind: currentSessionSourceKind,
    sourceId: currentSessionSourceId,
  });
  const sessionPeer = resolveDingTalkSessionPeer({
    isDirect,
    senderId,
    conversationId: groupId,
    peerIdOverride,
    config: dingtalkConfig,
  });

  // Single routing decision for this message. Skipped for recursive sub-agent
  // calls, where routing is already fixed by subAgentOptions.
  const messageTarget = subAgentOptions
    ? null
    : resolveMessageTarget({ extractedContent, cfg, isGroup });

  const invalidateQuestionRoutes = (routes: readonly ResolvedDingTalkRoute[]): void => {
    if (inboundOrigin === "ask-user") {
      return;
    }
    const scopeKeys = new Set(
      routes.map((resolvedRoute) => `${accountId}:${resolvedRoute.sessionKey}:${senderId}`),
    );
    const invalidatedRecords = [];
    for (const questionScopeKey of scopeKeys) {
      try {
        invalidatedRecords.push(
          ...invalidateAskUserQuestionsForScope({
            storePath: accountStorePath,
            accountId,
            questionScopeKey,
            reason: "superseded_by_message",
            log,
          }),
        );
      } catch (err) {
        log?.warn?.(
          `[DingTalk][AskUser] Failed to invalidate pending cards before inbound dispatch scope=${questionScopeKey}: ${String(err)}`,
        );
      }
    }
    if (invalidatedRecords.length === 0) {
      return;
    }
    void syncInvalidatedAskUserQuestionCards({
      records: invalidatedRecords,
      config: dingtalkConfig,
      log,
    }).catch((err) => {
      log?.warn?.(`[DingTalk][AskUser] Card invalidation sync failed: ${String(err)}`);
    });
  };

  // @Sub-Agent routing: dispatch @mention-targeted messages to their agent(s).
  // Both content (`@agent <message>`) and commands (`@agent /new`) re-enter
  // handleDingTalkMessage via dispatchSubAgents with subAgentOptions set, so the
  // agent session key, helper-missing fallback, and recursion live in one path.
  if (messageTarget && messageTarget.kind !== "default") {
    if (messageTarget.kind === "subagent-command") {
      await dispatchSubAgents({
        matchedAgents: [messageTarget.agent],
        commandText: messageTarget.commandText,
        cfg,
        accountId,
        data,
        dingtalkConfig,
        sessionWebhook,
        extractedContent,
        sessionPeer,
        onRoutesResolved: (targets) =>
          invalidateQuestionRoutes(targets.map((target) => target.route)),
        handleMessage: handleDingTalkMessage,
        downloadMedia,
        log,
      });
      return;
    }

    if (messageTarget.hasInvalidAgentNames) {
      await sendUnmatchedAgentNotice({
        unmatchedNames: messageTarget.unmatchedNames,
        isGroup,
        senderId,
        dingtalkConfig,
        sessionWebhook,
        log,
      });
    }
    if (messageTarget.matchedAgents.length > 0) {
      log?.info?.(
        `[DingTalk] Sub-agent resolve: matched=${messageTarget.matchedAgents
          .map((a) => a.agentId)
          .join(",")} unmatched=${messageTarget.unmatchedNames.join(",")}`,
      );
      await dispatchSubAgents({
        matchedAgents: messageTarget.matchedAgents,
        cfg,
        accountId,
        data,
        dingtalkConfig,
        sessionWebhook,
        extractedContent,
        sessionPeer,
        onRoutesResolved: (targets) =>
          invalidateQuestionRoutes(targets.map((target) => target.route)),
        handleMessage: handleDingTalkMessage,
        downloadMedia,
        log,
      });
      return;
    }
    // Only invalid agent names and no match: fall through to the default route.
  }

  let route: ResolvedDingTalkRoute;
  if (routeOverride) {
    route = routeOverride;
  } else if (subAgentOptions) {
    route = {
      agentId: subAgentOptions.agentId,
      sessionKey: buildAgentSessionKey({
        rt,
        cfg,
        accountId,
        agentId: subAgentOptions.agentId,
        peerKind: sessionPeer.kind,
        peerId: sessionPeer.peerId,
      }),
      mainSessionKey: "",
    };
  } else {
    route = rt.channel.routing.resolveAgentRoute({
      cfg,
      channel: "dingtalk",
      accountId,
      peer: { kind: sessionPeer.kind, id: sessionPeer.peerId },
    });
  }
  const questionContext = getDingTalkQuestionContext();
  if (questionContext) {
    questionContext.resolvedRoute = route;
    questionContext.questionScopeKey = `${accountId}:${route.sessionKey}:${senderId}`;
    questionContext.storePath = accountStorePath;
    questionContext.continuationSubAgentOptions = subAgentOptions
      ? {
          agentId: subAgentOptions.agentId,
          responsePrefix: subAgentOptions.responsePrefix,
          matchedName: subAgentOptions.matchedName,
        }
      : undefined;
  }
  if (!subAgentOptions) {
    invalidateQuestionRoutes([route]);
  }

  // Route resolved before media download for session context and routing metadata.
  const storePath = rt.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });

  const to = isDirect ? senderId : groupId;
  const commandHandled = await handleInboundCommandDispatch({
    cfg,
    accountId,
    dingtalkConfig,
    senderId,
    isDirect,
    extractedText: subAgentOptions?.commandText ?? extractedContent.text,
    messageType: extractedContent.messageType,
    data: {
      conversationId: data.conversationId,
      senderId: data.senderId,
      senderStaffId: data.senderStaffId,
    },
    accountStorePath,
    currentSessionSourceKind,
    currentSessionSourceId,
    peerIdOverride,
    sessionPeer,
    sendReply: async (text: string) => {
      await sendBySession(dingtalkConfig, sessionWebhook, text, { log });
    },
    clearSessionPeerOverride,
    setSessionPeerOverride,
  });
  if (commandHandled) {
    return;
  }

  const journalTTLDays = dingtalkConfig.journalTTLDays ?? DEFAULT_MESSAGE_CONTEXT_TTL_DAYS;
  const quotedRef = buildInboundQuotedRef(data, extractedContent);
  const replyQuotedRef = createReplyQuotedRef(data.msgId);
  const content = extractedContent;
  const isBtwBypass = isBtwRequestText(stripLeadingMentions(content.text).trim());
  const taskInfoConversationId = groupId || to;
  const agentDisplayName = getAgentDisplayName({
    subAgentOptions,
    agentId: route.agentId,
    agentsList: cfg.agents?.list,
  });
  const configuredTaskMetadata = resolveConfiguredTaskModelMetadata({
    cfg,
    agentId: route.agentId,
  });
  const sessionTaskStateScope = {
    accountId,
    conversationId: taskInfoConversationId,
    agentId: route.agentId,
  };
  const sessionTaskState = initSessionState(sessionTaskStateScope, configuredTaskMetadata);
  const initialStatusLine =
    renderStatusLine(
      {
        model: sessionTaskState.model,
        effort: sessionTaskState.effort,
        agent: agentDisplayName,
      },
      dingtalkConfig,
    ) || undefined;

  // 3) Select response mode (card vs markdown).
  // Card creation runs BEFORE media download so the user sees immediate visual
  // feedback while large files are still being downloaded.
  // /btw is gated out here (`!isBtwBypass`) because it must never create a card —
  // it has its own bypass dispatch later that returns before reaching the main
  // run. Abort (/stop) is intentionally NOT gated: in card mode the existing
  // abort branch finalizes the card with the abort confirmation text instead of
  // sending a separate plain-text message.
  let useCardMode = dingtalkConfig.messageType === "card";
  let currentAICard: import("./types").AICardInstance | undefined;
  let questionCardTookOver = false;

  let cardFlightKey: string | undefined;
  if (questionContext) {
    questionContext.onQuestionCardSent = async ({ questionId, outTrackId }) => {
      if (cardFlightKey) {
        cardCreationInFlight.delete(cardFlightKey);
        cardFlightKey = undefined;
      }
      try {
        await dispatchDingTalkCardStopCommand({
          cfg,
          accountId,
          agentId: route.agentId,
          targetSessionKey: route.sessionKey,
          clickerUserId: senderId || "unknown",
          log,
        });
        log?.info?.(
          `[DingTalk][AskUser] Dispatched targeted stop after question card sent question=${questionId} outTrackId=${outTrackId} targetSessionKey=${route.sessionKey}`,
        );
      } catch (err) {
        log?.warn?.(
          `[DingTalk][AskUser] Question card sent, but targeted stop failed question=${questionId} outTrackId=${outTrackId} targetSessionKey=${route.sessionKey}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
      questionCardTookOver = true;
      if (!currentAICard) {
        return true;
      }
      if (isCardInTerminalState(currentAICard.state)) {
        return true;
      }
      let recalled = false;
      try {
        recalled = await recallAICardMessage(currentAICard, log);
      } catch (err) {
        log?.warn?.(
          `[DingTalk][AskUser] Question card took over, but AI card recall errored question=${questionId} outTrackId=${outTrackId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return true;
      }
      if (!recalled) {
        log?.warn?.(
          `[DingTalk][AskUser] Question card sent, but AI card recall failed; normal replies remain suppressed question=${questionId} outTrackId=${outTrackId}`,
        );
        return true;
      }
      log?.info?.(
        `[DingTalk][AskUser] Recalled empty AI card after question card sent question=${questionId} outTrackId=${outTrackId}`,
      );
      return true;
    };
  }

  if (useCardMode && !isBtwBypass) {
    const key = `${accountId}:${to}`;
    if (cardCreationInFlight.has(key)) {
      useCardMode = false;
      log?.debug?.(
        `[DingTalk][AICard] Skip card creation - active card already exists for account=${accountId} conversation=${to}`,
      );
    } else {
      cardCreationInFlight.add(key);
      cardFlightKey = key;
    }
  }

  if (useCardMode && !isBtwBypass) {
    try {
      log?.debug?.(
        `[DingTalk][AICard] conversationType=${data.conversationType}, conversationId=${to}`,
      );
      // quoteContent always shows the inbound message text so the user can
      // identify which of their messages this card is replying to.
      // Use rawInboundText ( preserved before sub-agent rewriting) to avoid
      // showing internal routing context like "[你被 @ 为...]" in the card UI.
      const inboundQuoteText = rawInboundText.slice(0, 200);
      const aiCard = await createAICard(dingtalkConfig, to, log, {
        accountId,
        storePath: accountStorePath,
        contextConversationId: groupId,
        quoteContent: inboundQuoteText,
        statusLine: initialStatusLine,
      });
      if (aiCard) {
        currentAICard = aiCard;
        if (aiCard.outTrackId) {
          registerCardRun(aiCard.outTrackId, {
            accountId,
            sessionKey: route.sessionKey,
            agentId: route.agentId,
            ownerUserId: senderId,
            card: aiCard,
          });
        }
      } else {
        useCardMode = false;
        if (cardFlightKey) {
          cardCreationInFlight.delete(cardFlightKey);
          cardFlightKey = undefined;
        }
        log?.warn?.(
          "[DingTalk] Failed to create AI card (returned null), fallback to text/markdown.",
        );
      }
    } catch (err: any) {
      useCardMode = false;
      if (cardFlightKey) {
        cardCreationInFlight.delete(cardFlightKey);
        cardFlightKey = undefined;
      }
      log?.warn?.(
        `[DingTalk] Failed to create AI card: ${err.message}, fallback to text/markdown.`,
      );
    }
  }
  // Outer try/finally guarantees cardFlightKey cleanup even when the handler
  // returns or throws between card creation and session-lock release.
  try {
    const hasLegacyQuoteContent =
      typeof data.content?.quoteContent === "string" && data.content.quoteContent.trim().length > 0;

    if (hasLegacyQuoteContent && !quotedRef) {
      log?.debug?.(
        `[DingTalk] Legacy quoteContent present without resolvable quotedRef: ` +
          `conversationType=${data.conversationType} conversationId=${data.conversationId} ` +
          `msgId=${data.msgId} originalMsgId=${data.originalMsgId || "(none)"}`,
      );
    }
    if (quotedRef) {
      log?.debug?.(
        `[DingTalk][QuotedRef] Built inbound quotedRef msgId=${data.msgId} scope=${groupId} ` +
          `quotedRef=${JSON.stringify(quotedRef)}`,
      );
    } else if (
      data.text?.isReplyMsg ||
      data.originalMsgId ||
      data.originalProcessQueryKey ||
      content.quoted
    ) {
      log?.debug?.(
        `[DingTalk][QuotedRef] Reply metadata present without resolvable quotedRef ` +
          `msgId=${data.msgId} scope=${groupId} originalMsgId=${data.originalMsgId || "(none)"} ` +
          `originalProcessQueryKey=${data.originalProcessQueryKey || "(none)"}`,
      );
    }

    try {
      upsertInboundMessageContext({
        storePath: accountStorePath,
        accountId,
        conversationId: groupId,
        msgId: data.msgId,
        messageType: content.messageType,
        text: content.text,
        quotedRef,
        senderId,
        senderName,
        createdAt: data.createAt,
        ttlMs: ttlDaysToMs(journalTTLDays),
        ttlReferenceMs: data.createAt,
        cleanupCreatedAtTtlDays: journalTTLDays,
        topic: null,
      });
    } catch (err) {
      log?.warn?.(`[DingTalk] Message context inbound append failed: ${String(err)}`);
    }

    const robotCode = resolveRobotCode(dingtalkConfig);
    let mediaPath: string | undefined;
    let mediaType: string | undefined;
    const mediaPaths: string[] = [];
    const mediaTypes: string[] = [];
    let attachmentContextMsgId = data.msgId;
    let attachmentContextCreatedAt = data.createAt;
    let attachmentContextMessageType = content.messageType;
    let attachmentContextFileName = data.content?.fileName;

    // Use pre-downloaded media if available (from sub-agent outer call)
    if (preDownloadedMedia?.mediaPath) {
      mediaPath = preDownloadedMedia.mediaPath;
      mediaType = preDownloadedMedia.mediaType;
      if (preDownloadedMedia.mediaPaths?.length) {
        mediaPaths.push(...preDownloadedMedia.mediaPaths);
        for (let i = 0; i < preDownloadedMedia.mediaPaths.length; i++) {
          mediaTypes.push(
            preDownloadedMedia.mediaTypes?.[i] || preDownloadedMedia.mediaType || "file",
          );
        }
      } else {
        mediaPaths.push(mediaPath);
        mediaTypes.push(mediaType || "file");
      }
    } else if (robotCode) {
      // Download all media attachments (richText may carry multiple images).
      const downloadCodes =
        content.mediaPaths && content.mediaPaths.length > 0
          ? content.mediaPaths
          : content.mediaPath
            ? [content.mediaPath]
            : [];
      for (const downloadCode of downloadCodes) {
        const media = await downloadMedia(
          dingtalkConfig,
          downloadCode,
          log,
          attachmentContextFileName,
        );
        if (media) {
          if (!mediaPath) {
            mediaPath = media.path;
            mediaType = media.mimeType;
          }
          mediaPaths.push(media.path);
          mediaTypes.push(media.mimeType);
        }
      }
    }

    // Cache downloadCode(s) (+ spaceId/fileId) for quoted file lookups (DM + group).
    const allMediaDownloadCodes =
      content.mediaPaths && content.mediaPaths.length > 0
        ? content.mediaPaths
        : content.mediaPath
          ? [content.mediaPath]
          : [];
    if (allMediaDownloadCodes.length > 0 && data.msgId) {
      upsertInboundMessageContext({
        storePath: accountStorePath,
        accountId,
        conversationId: data.conversationId,
        msgId: data.msgId,
        createdAt: data.createAt,
        messageType: content.messageType,
        media: {
          downloadCode: allMediaDownloadCodes[0],
          downloadCodes: allMediaDownloadCodes.length > 1 ? allMediaDownloadCodes : undefined,
          spaceId: data.content?.spaceId,
          fileId: data.content?.fileId,
        },
        attachmentFileName: attachmentContextFileName,
        ttlMs: DEFAULT_MEDIA_CONTEXT_TTL_MS,
        topic: null,
      });
    }

    // User-sent DingTalk doc / Drive file card: cache msgId -> {spaceId,fileId}
    // during the original message turn, and try downloading immediately in DM.
    if (
      content.messageType === "interactiveCardFile" &&
      data.msgId &&
      content.docSpaceId &&
      content.docFileId
    ) {
      upsertInboundMessageContext({
        storePath: accountStorePath,
        accountId,
        conversationId: data.conversationId,
        msgId: data.msgId,
        createdAt: data.createAt,
        messageType: content.messageType,
        media: {
          spaceId: content.docSpaceId,
          fileId: content.docFileId,
        },
        attachmentFileName: attachmentContextFileName,
        ttlMs: DEFAULT_MEDIA_CONTEXT_TTL_MS,
        topic: null,
      });

      if (!mediaPath && isDirect && data.senderStaffId) {
        try {
          const unionId = await getUnionIdByStaffId(dingtalkConfig, data.senderStaffId, log);
          const docMedia = await downloadGroupFile(
            dingtalkConfig,
            content.docSpaceId,
            content.docFileId,
            unionId,
            log,
            attachmentContextFileName,
          );
          if (docMedia) {
            mediaPath = docMedia.path;
            mediaType = docMedia.mimeType;
            mediaPaths.push(docMedia.path);
            mediaTypes.push(docMedia.mimeType);
          }
        } catch (err: any) {
          log?.warn?.(`[DingTalk] Doc card download failed: ${err.message}`);
        }
      }
    }

    const quotedRecord = resolveQuotedRecord({
      storePath: accountStorePath,
      accountId,
      conversationId: data.conversationId,
      quotedRef,
      log,
    });
    const quotedRuntimeContext = filterQuotedRuntimeContext({
      context: resolveQuotedRuntimeContext({
        storePath: accountStorePath,
        accountId,
        conversationId: data.conversationId,
        quotedRef,
        firstRecord: quotedRecord,
        firstPreview:
          content.quoted?.previewText || content.quoted?.previewMessageType
            ? {
                text: content.quoted.previewText,
                messageType: content.quoted.previewMessageType,
                senderId: content.quoted.previewSenderId,
              }
            : undefined,
        log,
      }),
      config: dingtalkConfig,
      isDirect,
      groupId,
      quotedSenderId: quotedRecord?.senderId || content.quoted?.previewSenderId,
      currentSenderId: senderId,
      currentSenderOriginalId: senderOriginalId,
    });

    // Try downloading a quoted file from cached downloadCode/spaceId+fileId.
    const tryDownloadFromRecord = async (
      record: {
        msgId?: string;
        media?: {
          downloadCode?: string;
          spaceId?: string;
          fileId?: string;
        };
      } | null,
      originalFilename?: string,
    ): Promise<MediaFile | null> => {
      if (!record?.media) {
        return null;
      }
      let media: MediaFile | null = null;
      if (record.media.downloadCode) {
        media = await downloadMedia(
          dingtalkConfig,
          record.media.downloadCode,
          log,
          originalFilename,
        );
        if (media) {
          log?.debug?.(
            `[DingTalk][QuotedRef] Recovered quoted media from cached downloadCode ` +
              `recordMsgId=${record.msgId || "(none)"} scope=${data.conversationId}`,
          );
        }
      }
      if (!media && record.media.spaceId && record.media.fileId && data.senderStaffId) {
        try {
          const unionId = await getUnionIdByStaffId(dingtalkConfig, data.senderStaffId, log);
          media = await downloadGroupFile(
            dingtalkConfig,
            record.media.spaceId,
            record.media.fileId,
            unionId,
            log,
            originalFilename,
          );
          if (media) {
            log?.debug?.(
              `[DingTalk][QuotedRef] Recovered quoted media from cached spaceId/fileId ` +
                `recordMsgId=${record.msgId || "(none)"} scope=${data.conversationId}`,
            );
          }
        } catch (err: any) {
          log?.warn?.(`[DingTalk] spaceId+fileId fallback failed: ${err.message}`);
        }
      }
      return media;
    };

    // Quoted multi-image richText: recover all cached downloadCodes.
    // Placed before the single-image/ file/ doc-card paths so that the
    // !mediaPath guard prevents those paths from downloading only the first image.
    if (
      !mediaPath &&
      quotedRecord?.media?.downloadCodes &&
      quotedRecord.media.downloadCodes.length > 1
    ) {
      const recovered: MediaFile[] = [];
      for (const code of quotedRecord.media.downloadCodes) {
        const result = await downloadMedia(dingtalkConfig, code, log);
        if (result) {
          recovered.push(result);
        }
      }
      if (recovered.length > 0) {
        mediaPath = recovered[0].path;
        mediaType = recovered[0].mimeType;
        for (const m of recovered) {
          mediaPaths.push(m.path);
          mediaTypes.push(m.mimeType);
        }
        attachmentContextMsgId = quotedRecord.msgId || data.msgId;
        attachmentContextCreatedAt = quotedRecord.createdAt || data.createAt;
        attachmentContextMessageType = quotedRecord.messageType || "richText";
        log?.debug?.(
          `[DingTalk][QuotedRef] Recovered ${recovered.length} images from cached multi-image richText ` +
            `recordMsgId=${quotedRecord.msgId || "(none)"} scope=${data.conversationId}`,
        );
      }
    }

    // Quoted picture: download via existing downloadMedia.
    if (!mediaPath && content.quoted?.mediaDownloadCode && robotCode) {
      const quotedOriginalFilename = content.quoted.previewFileName;
      const media =
        (await tryDownloadFromRecord(quotedRecord, quotedOriginalFilename)) ||
        (await downloadMedia(
          dingtalkConfig,
          content.quoted.mediaDownloadCode,
          log,
          quotedOriginalFilename,
        ));
      if (media) {
        if (!quotedRecord) {
          log?.debug?.(
            `[DingTalk][QuotedRef] Recovered quoted image from inbound downloadCode fallback scope=${data.conversationId}`,
          );
        }
        mediaPath = media.path;
        mediaType = media.mimeType;
        mediaPaths.push(media.path);
        mediaTypes.push(media.mimeType);
        attachmentContextMsgId = quotedRecord?.msgId || content.quoted.msgId || data.msgId;
        attachmentContextCreatedAt = quotedRecord?.createdAt || data.createAt;
        attachmentContextMessageType =
          quotedRecord?.messageType || content.quoted.previewMessageType || "picture";
        attachmentContextFileName = content.quoted.previewFileName;
      } else {
        content.text = `[引用了一张图片，但下载失败]\n\n${content.text}`;
      }
    }

    // Quoted file/audio/video (file/audio/video msgType) or unknownMsgType:
    // Step 0 tries direct downloadCode; Steps 1-2 fall back to cache and group file API.
    if (!mediaPath && content.quoted?.isQuotedFile) {
      let fileResolved = false;

      // Step 0: Direct download via downloadCode from quoted payload (file/audio/video msgType).
      if (!fileResolved && content.quoted.fileDownloadCode && robotCode) {
        const media = await downloadMedia(
          dingtalkConfig,
          content.quoted.fileDownloadCode,
          log,
          content.quoted.previewFileName,
        );
        if (media) {
          mediaPath = media.path;
          mediaType = media.mimeType;
          mediaPaths.push(media.path);
          mediaTypes.push(media.mimeType);
          attachmentContextMsgId = content.quoted.msgId || data.msgId;
          attachmentContextCreatedAt = content.quoted.fileCreatedAt || data.createAt;
          attachmentContextMessageType = content.quoted.previewMessageType || "file";
          attachmentContextFileName = content.quoted.previewFileName;
          fileResolved = true;
          log?.debug?.(
            `[DingTalk][QuotedRef] Downloaded quoted file via direct downloadCode scope=${data.conversationId}`,
          );
        }
      }

      // Step 1: Prefer quotedRef-backed record lookup, then msgId-based cache.
      if (!fileResolved) {
        const cachedMedia = await tryDownloadFromRecord(
          quotedRecord,
          quotedRecord?.attachmentFileName || content.quoted.previewFileName,
        );
        if (cachedMedia) {
          mediaPath = cachedMedia.path;
          mediaType = cachedMedia.mimeType;
          mediaPaths.push(cachedMedia.path);
          mediaTypes.push(cachedMedia.mimeType);
          attachmentContextMsgId = quotedRecord?.msgId || content.quoted.msgId || data.msgId;
          attachmentContextCreatedAt =
            quotedRecord?.createdAt || content.quoted.fileCreatedAt || data.createAt;
          attachmentContextMessageType = quotedRecord?.messageType || "file";
          attachmentContextFileName =
            quotedRecord?.attachmentFileName || content.quoted.previewFileName;
          fileResolved = true;
        }
      }

      // Step 2 (group only): Cache miss → fall back to group file API time-based matching.
      if (!fileResolved && !isDirect) {
        const resolved = await resolveQuotedFile(
          dingtalkConfig,
          {
            openConversationId: data.conversationId,
            senderStaffId: data.senderStaffId,
            fileCreatedAt: content.quoted.fileCreatedAt,
          },
          log,
        );
        if (resolved) {
          mediaPath = resolved.media.path;
          mediaType = resolved.media.mimeType;
          mediaPaths.push(resolved.media.path);
          mediaTypes.push(resolved.media.mimeType);
          attachmentContextMsgId = content.quoted.msgId || data.msgId;
          attachmentContextCreatedAt = content.quoted.fileCreatedAt || data.createAt;
          attachmentContextMessageType = "file";
          attachmentContextFileName = resolved.name || content.quoted.previewFileName;
          fileResolved = true;
          log?.debug?.(
            `[DingTalk][QuotedRef] Recovered quoted file from group file fallback ` +
              `scope=${data.conversationId} quotedMsgId=${content.quoted.msgId || "(none)"}`,
          );
          if (content.quoted.msgId) {
            upsertInboundMessageContext({
              storePath: accountStorePath,
              accountId,
              conversationId: data.conversationId,
              msgId: content.quoted.msgId,
              createdAt: content.quoted.fileCreatedAt || Date.now(),
              messageType: "file",
              media: {
                spaceId: resolved.spaceId,
                fileId: resolved.fileId,
              },
              attachmentFileName: resolved.name,
              ttlMs: DEFAULT_MEDIA_CONTEXT_TTL_MS,
              topic: null,
            });
          }
        }
      }

      if (!fileResolved) {
        log?.warn?.(
          `[DingTalk] Quoted file unresolved: conversationType=${data.conversationType} conversationId=${data.conversationId} quotedMsgId=${content.quoted.msgId || "(none)"}`,
        );
        const hint = isDirect
          ? "[引用了一个文件，内容无法自动获取，请直接发送该文件]\n\n"
          : "[引用了一个文件，但无法获取内容]\n\n";
        content.text = `${hint}${content.text}`;
      }
    }

    // Quoted DingTalk doc / Drive file card:
    // 1) Prefer msgId-based cached metadata captured when the original doc card
    //    message was seen.
    // 2) In group chats, if the bot never saw the original doc card message,
    //    reuse the same group-file fallback chain as ordinary quoted files.
    if (!mediaPath && content.quoted?.isQuotedDocCard) {
      let docResolved = false;

      const cachedDocMedia = await tryDownloadFromRecord(
        quotedRecord,
        quotedRecord?.attachmentFileName || content.quoted?.previewFileName,
      );
      if (cachedDocMedia) {
        mediaPath = cachedDocMedia.path;
        mediaType = cachedDocMedia.mimeType;
        mediaPaths.push(cachedDocMedia.path);
        mediaTypes.push(cachedDocMedia.mimeType);
        attachmentContextMsgId = quotedRecord?.msgId || content.quoted.msgId || data.msgId;
        attachmentContextCreatedAt =
          quotedRecord?.createdAt || content.quoted.fileCreatedAt || data.createAt;
        attachmentContextMessageType =
          quotedRecord?.messageType || content.quoted.previewMessageType || "interactiveCardFile";
        attachmentContextFileName =
          quotedRecord?.attachmentFileName || content.quoted.previewFileName;
        docResolved = true;
      }

      if (!docResolved && !isDirect && content.quoted.fileCreatedAt) {
        const resolved = await resolveQuotedFile(
          dingtalkConfig,
          {
            openConversationId: data.conversationId,
            senderStaffId: data.senderStaffId,
            fileCreatedAt: content.quoted.fileCreatedAt,
          },
          log,
        );
        if (resolved) {
          mediaPath = resolved.media.path;
          mediaType = resolved.media.mimeType;
          mediaPaths.push(resolved.media.path);
          mediaTypes.push(resolved.media.mimeType);
          attachmentContextMsgId = content.quoted.msgId || data.msgId;
          attachmentContextCreatedAt = content.quoted.fileCreatedAt || data.createAt;
          attachmentContextMessageType = "interactiveCardFile";
          attachmentContextFileName = resolved.name || content.quoted.previewFileName;
          docResolved = true;
          log?.debug?.(
            `[DingTalk][QuotedRef] Recovered quoted doc card from group file fallback ` +
              `scope=${data.conversationId} quotedMsgId=${content.quoted.msgId || "(none)"}`,
          );
          if (content.quoted.msgId) {
            upsertInboundMessageContext({
              storePath: accountStorePath,
              accountId,
              conversationId: data.conversationId,
              msgId: content.quoted.msgId,
              createdAt: content.quoted.fileCreatedAt || Date.now(),
              messageType: "interactiveCardFile",
              media: {
                spaceId: resolved.spaceId,
                fileId: resolved.fileId,
              },
              attachmentFileName: resolved.name,
              ttlMs: DEFAULT_MEDIA_CONTEXT_TTL_MS,
              topic: null,
            });
          }
        }
      }

      if (!docResolved) {
        log?.warn?.(
          `[DingTalk] Quoted doc card unresolved: conversationType=${data.conversationType} conversationId=${data.conversationId} quotedMsgId=${content.quoted.msgId || "(none)"}`,
        );
        const hint = isDirect
          ? "[引用了钉钉文档，内容无法自动获取，请直接发送该文档]\n\n"
          : "[引用了钉钉文档，但无法获取内容]\n\n";
        content.text = `${hint}${content.text}`;
      }
    }

    let attachmentExtractedText: string | undefined;
    if (mediaPath) {
      try {
        const extracted = await extractAttachmentText({
          path: mediaPath,
          mimeType: mediaType,
          fileName: attachmentContextFileName || data.content?.fileName,
        });
        if (extracted?.text) {
          upsertInboundMessageContext({
            storePath: accountStorePath,
            accountId,
            conversationId: data.conversationId,
            msgId: attachmentContextMsgId,
            createdAt: attachmentContextCreatedAt,
            messageType: attachmentContextMessageType,
            attachmentText: extracted.text,
            attachmentTextSource: extracted.sourceType,
            attachmentTextTruncated: extracted.truncated,
            attachmentFileName: attachmentContextFileName,
            ttlMs: ttlDaysToMs(journalTTLDays),
            topic: null,
          });
          attachmentExtractedText = `${ATTACHMENT_TEXT_PREFIX}\n${extracted.text}`;
        }
      } catch (err: any) {
        log?.warn?.(`[DingTalk] Failed to extract attachment text: ${err.message}`);
      }
    }

    const inboundBody = content.text;
    const inboundText = attachmentExtractedText
      ? `${inboundBody.trimEnd()}\n\n${attachmentExtractedText}`
      : inboundBody;
    // Targeted slash commands (`@agent /new`) pass the @mention-stripped command
    // text as CommandBody so the framework command layer recognizes it, while
    // RawBody keeps the user's original input for audit/quote display.
    const commandBody = subAgentOptions?.commandText ?? inboundText;
    const learningEnabled = isLearningEnabled(dingtalkConfig);
    const learningContextBlock = buildLearningContextBlock({
      enabled: learningEnabled,
      storePath: accountStorePath,
      accountId,
      targetId: data.conversationId,
      content,
    });
    const envelopeOptions = rt.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const previousTimestamp = rt.channel.session.readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    });

    const groupConfig = !isDirect ? resolveGroupConfig(dingtalkConfig, groupId) : undefined;
    // GroupSystemPrompt is injected every turn (not only first-turn intro).
    const groupSystemPromptParts = !isDirect
      ? [
          buildGroupTurnContextPrompt({
            conversationId: groupId,
            senderDingtalkId: senderId,
            senderName,
          }),
          groupConfig?.systemPrompt?.trim(),
        ]
      : [];
    const extraSystemPrompt =
      [...groupSystemPromptParts, learningContextBlock].filter(Boolean).join("\n\n") || undefined;

    if (!isDirect) {
      noteGroupMember(storePath, groupId, senderId, senderName);
    }
    const groupMembers = !isDirect ? formatGroupMembers(storePath, groupId) : undefined;

    const fromLabel = isDirect ? `${senderName} (${senderId})` : `${groupName} - ${senderName}`;
    const body = rt.channel.reply.formatInboundEnvelope({
      channel: "DingTalk",
      from: fromLabel,
      timestamp: data.createAt,
      body: inboundText,
      chatType: isDirect ? "direct" : "group",
      sender: { name: senderName, id: senderId },
      previousTimestamp,
      envelope: envelopeOptions,
    });

    const ctx = rt.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: inboundText,
      CommandBody: commandBody,
      QuotedRef: quotedRef,
      QuotedRefJson: quotedRef ? JSON.stringify(quotedRef) : undefined,
      ReplyToId: quotedRuntimeContext?.replyToId,
      ReplyToBody: quotedRuntimeContext?.replyToBody,
      ReplyToSender: quotedRuntimeContext?.replyToSender,
      ReplyToIsQuote: quotedRuntimeContext?.replyToIsQuote,
      UntrustedContext: quotedRuntimeContext?.untrustedContext
        ? [quotedRuntimeContext.untrustedContext]
        : undefined,
      From: to,
      To: to,
      SessionKey: route.sessionKey,
      AccountId: accountId,
      ChatType: isDirect ? "direct" : "group",
      ConversationLabel: fromLabel,
      GroupSubject: isDirect ? undefined : groupName,
      SenderName: senderName,
      SenderId: senderId,
      Provider: "dingtalk",
      Surface: "dingtalk",
      MessageSid: data.msgId,
      Timestamp: data.createAt,
      MediaPath: mediaPath,
      MediaType: mediaType,
      MediaUrl: mediaPath,
      MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
      MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
      MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
      GroupMembers: groupMembers,
      GroupSystemPrompt: extraSystemPrompt,
      GroupChannel: isDirect ? undefined : route.sessionKey,
      CommandAuthorized: commandAuthorized,
      OriginatingChannel: "dingtalk",
      OriginatingTo: to,
    });

    await rt.channel.session.recordInboundSession({
      storePath,
      sessionKey: ctx.SessionKey || route.sessionKey,
      ctx,
      updateLastRoute: (() => {
        if (!isDirect) {
          return undefined;
        }
        const pinnedMainDmOwner = resolvePinnedMainDmOwner({
          dmScope: cfg.session?.dmScope,
          allowFrom: dingtalkConfig.allowFrom,
        });
        const senderRecipient = (senderOriginalId || senderId || "").trim().toLowerCase();
        if (
          pinnedMainDmOwner &&
          senderRecipient &&
          pinnedMainDmOwner.trim().toLowerCase() !== senderRecipient
        ) {
          log?.debug?.(
            `[DingTalk] Skipping main-session last route update for ${senderRecipient} (pinned owner ${pinnedMainDmOwner})`,
          );
          return undefined;
        }
        return { sessionKey: route.mainSessionKey, channel: "dingtalk", to, accountId };
      })(),
      onRecordError: (err: unknown) => {
        log?.error?.(`[DingTalk] Failed to record inbound session: ${String(err)}`);
      },
    });

    log?.info?.(`[DingTalk] Inbound: from=${senderName} text="${content.text.slice(0, 50)}..."`);

    // ---- Pre-lock abort: bypass session lock for stop requests ----
    // isAbortRequestText matches "/stop", "停止", "stop", "esc", etc.
    // Calling dispatchReplyWithBufferedBlockDispatcher without holding the lock lets
    // tryFastAbortFromMessage (inside the SDK) kill any in-flight generation immediately,
    // rather than waiting for it to finish before the stop message is processed.
    //
    // Strip leading @mention tokens before the abort check so that messages like
    // "@Agent /stop" are correctly recognised as abort requests in both DM and group
    // chats. In groups DingTalk usually strips @BotName at the protocol level, but
    // in DMs with multi-agent routing the @mention prefix survives all the way here.
    const textForAbortCheck = stripLeadingMentions(inboundText).trim();
    if (isAbortRequestText(textForAbortCheck)) {
      log?.info?.(
        `[DingTalk] Abort request detected, bypassing session lock for session=${route.sessionKey}`,
      );
      // In card mode: capture the abort confirmation text so we can write it into
      // the card (instead of sending a separate plain text message).
      let abortConfirmationText: string | undefined;
      try {
        await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx,
          cfg,
          dispatcherOptions: {
            responsePrefix: "",
            deliver: async (payload) => {
              if (!payload.text) {
                log?.debug?.(`[DingTalk] Abort deliver received non-text payload, skipping`);
                return;
              }
              if (currentAICard) {
                // Card mode: capture text — will be written to card after dispatch.
                abortConfirmationText = payload.text;
              } else {
                try {
                  if (sessionWebhook) {
                    await sendBySession(dingtalkConfig, sessionWebhook, payload.text, {
                      log,
                      accountId,
                      storePath: accountStorePath,
                    });
                  } else {
                    await sendMessage(dingtalkConfig, to, payload.text, {
                      log,
                      accountId,
                      storePath: accountStorePath,
                      conversationId: groupId,
                    });
                  }
                } catch (deliverErr) {
                  log?.warn?.(
                    `[DingTalk] Abort reply delivery failed: ${getErrorMessage(deliverErr)}`,
                  );
                }
              }
            },
          },
        });
      } catch (abortErr) {
        log?.warn?.(`[DingTalk] Abort dispatch failed: ${getErrorMessage(abortErr)}`);
      }
      // Finalize the card that was created for this message before the abort check.
      // Without this, the card stays in PROCESSING ("处理中...") indefinitely.
      // Use V2 finalize (commitAICardBlocks) for consistent state transition.
      if (currentAICard && !isCardInTerminalState(currentAICard.state)) {
        try {
          const abortText = abortConfirmationText ?? "已停止";
          const abortBlockList = [{ type: 0, markdown: abortText }];
          const blockListJson = JSON.stringify(abortBlockList);

          await commitAICardBlocks(
            currentAICard,
            {
              blockListJson,
              content: abortText,
            },
            log,
          );

          log?.debug?.(
            `[DingTalk] Abort card finalized via V2 API: card=${currentAICard.cardInstanceId}`,
          );
        } catch (cardErr) {
          log?.warn?.(`[DingTalk] Abort card finalize failed: ${getErrorMessage(cardErr)}`);
          currentAICard.state = AICardStatus.FAILED;
        }
      }
      return;
    }

    // ---- Pre-lock BTW: bypass session lock for /btw side questions ----
    // /btw runs an isolated, tool-less side query in openclaw without polluting
    // the main run's transcript. The dispatch must NOT acquire the session lock,
    // otherwise it would queue behind the in-flight main task and lose its "side
    // question" semantics.
    //
    // The `isBtwBypass` flag is computed once early (just after `content` is
    // resolved, just before `createAICard`). The same constant gates `createAICard` above and
    // drives this branch — single decision, two consequences. See the comment
    // at the flag's definition for why /btw uses pre-OCR `content.text` while
    // abort uses `inboundText`.
    if (isBtwBypass) {
      log?.info?.(
        `[DingTalk] BTW request detected, bypassing session lock for session=${route.sessionKey}`,
      );
      // Empty fallback (NOT "Unknown" like the file's main `senderName` variable):
      // when the nickname is missing we want the blockquote to render as
      // `> /btw <question>` rather than `> Unknown: /btw <question>`. Read locally
      // here so the existing `senderName` semantics elsewhere in the file are not
      // affected.
      const btwSenderName = data.senderNick || "";
      try {
        await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx,
          cfg,
          dispatcherOptions: {
            responsePrefix: "",
            deliver: async (payload) => {
              if (!payload.text) {
                log?.debug?.(`[DingTalk] BTW deliver received non-text payload, skipping`);
                return;
              }
              await deliverBtwReply({
                config: dingtalkConfig,
                sessionWebhook,
                conversationId: groupId,
                to,
                senderName: btwSenderName,
                // Use pre-OCR content.text (consistent with isBtwBypass detection)
                // so the blockquote shows the user's typed body, not body + OCR.
                rawQuestion: content.text,
                replyText: payload.text,
                log,
                accountId,
                storePath: accountStorePath,
              });
            },
          },
        });
      } catch (btwErr) {
        log?.warn?.(`[DingTalk] BTW dispatch failed: ${getErrorMessage(btwErr)}`);
      }
      return;
    }

    const ackReaction =
      typeof dingtalkConfig.ackReaction === "string"
        ? dingtalkConfig.ackReaction.trim()
        : resolveAckReactionSetting({
            cfg,
            accountId,
            agentId: route.agentId,
          });
    const normalizedAckReaction = ackReaction === "off" ? "" : ackReaction;
    const resolvedAckReaction =
      normalizedAckReaction === "kaomoji"
        ? classifyAckReactionEmoji(content.text).emoji
        : normalizedAckReaction === "emoji"
          ? "🤔思考中"
          : normalizedAckReaction;
    const shouldAttachAckReaction = Boolean(resolvedAckReaction);
    let ackReactionAttached = false;
    let ackReactionAttachedAt = 0;

    if (shouldAttachAckReaction) {
      ackReactionAttached = await attachNativeAckReaction(
        dingtalkConfig,
        {
          msgId: data.msgId,
          conversationId: groupId,
          reactionName: resolvedAckReaction,
        },
        log,
      );
      if (ackReactionAttached) {
        ackReactionAttachedAt = Date.now();
        log?.debug?.(
          `[DingTalk] Initial ack reaction attached mode=${normalizedAckReaction || "off"} reaction=${resolvedAckReaction}`,
        );
      }
    }

    function parseInlineReplyPayloadText(text: unknown): {
      text?: string;
      mediaUrls: string[];
      audioAsVoice: boolean;
    } {
      if (typeof text !== "string") {
        return { text: undefined, mediaUrls: [], audioAsVoice: false };
      }

      const normalizedText = text.replace(/\r\n/g, "\n");
      const parsedInline = normalizedText.includes("[[")
        ? parseInlineDirectives(normalizedText, {
            stripAudioTag: true,
            stripReplyTags: false,
          })
        : {
            text: normalizedText,
            audioAsVoice: false,
            replyToCurrent: false,
            hasAudioTag: false,
            hasReplyTag: false,
          };
      const mediaUrls: string[] = [];
      const contentLines: string[] = [];

      for (const line of parsedInline.text.split("\n")) {
        const trimmed = line.trim();
        const mediaCandidate = trimmed.replace(/^(?:\[\[[^[\]]+\]\]\s*)+/, "");
        if (mediaCandidate.startsWith(MEDIA_DIRECTIVE_PREFIX)) {
          const mediaSource = mediaCandidate.slice(MEDIA_DIRECTIVE_PREFIX.length).trim();
          if (mediaSource) {
            mediaUrls.push(mediaSource);
            continue;
          }
        }
        contentLines.push(line);
      }

      const cleanedText = contentLines.join("\n").trim();
      const inlineTextWasTransformed = parsedInline.text !== normalizedText;
      if (mediaUrls.length === 0) {
        const standaloneMediaSource = extractStandaloneMediaSource(cleanedText);
        if (standaloneMediaSource) {
          return {
            text: undefined,
            mediaUrls: [standaloneMediaSource],
            audioAsVoice: parsedInline.audioAsVoice,
          };
        }
      }

      return {
        // Keep ordinary text formatting stable except for newline normalization.
        // Once inline parsing actually strips directives/media lines, return the
        // cleaned body text instead of the original raw payload.
        text:
          mediaUrls.length > 0 || inlineTextWasTransformed
            ? cleanedText || undefined
            : normalizedText,
        mediaUrls,
        audioAsVoice: parsedInline.audioAsVoice,
      };
    }

    function extractStandaloneMediaSource(text: string): string | undefined {
      const trimmed = text.trim();
      if (!trimmed || trimmed.includes("\n") || /\s/.test(trimmed)) {
        return undefined;
      }

      const hasPathLikeShape =
        /^https?:\/\/\S+$/i.test(trimmed) ||
        trimmed.startsWith("~/") ||
        trimmed.startsWith("~\\") ||
        trimmed.startsWith("./") ||
        trimmed.startsWith(".\\") ||
        trimmed.startsWith("../") ||
        trimmed.startsWith("..\\") ||
        trimmed.startsWith("/") ||
        trimmed.startsWith("\\") ||
        /^[a-zA-Z]:[\\/]/.test(trimmed) ||
        trimmed.includes("/") ||
        trimmed.includes("\\");
      if (!hasPathLikeShape) {
        return undefined;
      }

      return STANDALONE_MEDIA_PATH_EXTENSIONS.has(path.extname(trimmed).toLowerCase())
        ? trimmed
        : undefined;
    }

    // ---- Shared media delivery helper ----
    function extractSharedAudioAsVoice(
      payload: ReplyStreamPayload,
      inlineReplyPayload?: ReturnType<typeof parseInlineReplyPayloadText>,
    ): boolean {
      // Normalize all reply-time voice hints into the shared `audioAsVoice`
      // semantic that strategies and media delivery use downstream.
      const richPayload = payload as ReplyStreamPayload & {
        audioAsVoice?: unknown;
        asVoice?: unknown;
      };
      const sharedValue = parseBooleanLike(richPayload.audioAsVoice);
      if (sharedValue !== undefined) {
        return sharedValue;
      }
      if (parseBooleanLike(richPayload.asVoice) === true) {
        return true;
      }
      return inlineReplyPayload?.audioAsVoice === true;
    }

    async function deliverMediaAttachments(urls: string[], options?: { audioAsVoice?: boolean }) {
      for (const rawMediaUrl of urls) {
        const preparedMedia = await prepareMediaInput(
          rawMediaUrl,
          log,
          dingtalkConfig.mediaUrlAllowlist,
        );
        try {
          const actualMediaPath = preparedMedia.cleanup
            ? preparedMedia.path
            : resolveRelativePath(preparedMedia.path);
          const outMediaType = resolveOutboundMediaType({
            mediaPath: actualMediaPath,
            asVoice: options?.audioAsVoice === true,
          });
          if (sessionWebhook) {
            const sendResult = await sendMessage(dingtalkConfig, to, "", {
              sessionWebhook,
              mediaPath: actualMediaPath,
              mediaType: outMediaType,
              log,
              accountId,
              storePath: accountStorePath,
              conversationId: groupId,
              quotedRef: replyQuotedRef,
            });
            if (!sendResult.ok) {
              throw new Error(sendResult.error || "Media reply send failed");
            }
          } else {
            const sendResult = await sendProactiveMedia(
              dingtalkConfig,
              to,
              actualMediaPath,
              outMediaType,
              {
                accountId,
                log,
                storePath: accountStorePath,
                conversationId: groupId,
                quotedRef: replyQuotedRef,
              },
            );
            if (!sendResult.ok) {
              throw new Error(sendResult.error || "Media reply send failed");
            }
          }
        } finally {
          await preparedMedia.cleanup?.();
        }
      }
    }

    // ---- Extract mediaUrls from runtime payload ----
    function extractMediaUrls(
      payload: ReplyStreamPayload,
      inlineReplyPayload?: ReturnType<typeof parseInlineReplyPayloadText>,
    ): string[] {
      const richPayload = payload as typeof payload & {
        mediaUrl?: string;
        mediaUrls?: string[];
      };
      const explicitMediaUrls = Array.isArray(richPayload.mediaUrls)
        ? richPayload.mediaUrls.filter(
            (entry: unknown) => typeof entry === "string" && entry.trim(),
          )
        : richPayload.mediaUrl &&
            typeof richPayload.mediaUrl === "string" &&
            richPayload.mediaUrl.trim()
          ? [richPayload.mediaUrl]
          : [];
      return explicitMediaUrls.length > 0
        ? explicitMediaUrls
        : (inlineReplyPayload?.mediaUrls ?? []);
    }

    // Serialize dispatchReply + card finalize per session to prevent the runtime
    // from receiving concurrent dispatch calls on the same session key, which
    // causes empty replies for all but the first caller.
    // Each sub-agent call acquires its own lock since sub-agent sessions have
    // different session keys (different agentId), so no deadlock risk.
    const currentOutTrackId = currentAICard?.outTrackId;
    const shouldTrackDynamicAckReaction =
      (normalizedAckReaction === "emoji" || normalizedAckReaction === "kaomoji") &&
      shouldAttachAckReaction;
    const runtimeEvents = (
      rt as typeof rt & {
        events?: {
          onAgentEvent?: (listener: (event: unknown) => void) => () => void;
        };
      }
    ).events;
    const releaseSessionLock = await acquireSessionLock(route.sessionKey);
    const dynamicAckReactionController = createDynamicAckReactionController({
      enabled: shouldTrackDynamicAckReaction,
      initialReaction: resolvedAckReaction || "",
      initialAttached: ackReactionAttached,
      initialAttachedAt: ackReactionAttachedAt,
      dingtalkConfig,
      msgId: data.msgId,
      conversationId: groupId,
      sessionKey: route.sessionKey,
      log,
      runtimeEvents,
      onReactionDisposed: () => {
        ackReactionAttached = false;
      },
    });
    try {
      if (!ackReactionAttached && shouldAttachAckReaction) {
        log?.debug?.("[DingTalk] Native ack reaction unavailable; skipping fallback.");
      }
      const isCurrentCardStopRequested = () =>
        Boolean(
          currentAICard &&
          (currentAICard.state === AICardStatus.STOPPED ||
            (currentOutTrackId && isCardRunStopRequested(currentOutTrackId))),
        );

      if (isCurrentCardStopRequested()) {
        log?.info?.(
          "[DingTalk][CardStop] Skip dispatch because card was already stopped before session lock was acquired",
        );
        return;
      }

      // ---- Create reply strategy (card or markdown) ----
      const replyMode: ReplyMode = useCardMode && !!currentAICard ? "card" : "markdown";
      const sessionReasoningLevel = readSessionReasoningLevel({
        storePath,
        sessionKey: route.sessionKey,
        sessionUpdatedAt: previousTimestamp,
        log,
      });
      const legacyCardStreamReasoning = resolveLegacyCardStreamReasoningForInternalUse({
        cfg,
        accountId,
      });
      const strategyConfig =
        legacyCardStreamReasoning === undefined
          ? dingtalkConfig
          : { ...dingtalkConfig, cardStreamReasoning: legacyCardStreamReasoning };
      const sessionTaskState = getSessionState(sessionTaskStateScope);
      const taskMeta = {
        model: sessionTaskState?.model,
        effort: sessionTaskState?.effort,
        elapsedMs:
          typeof sessionTaskState?.taskStartTime === "number"
            ? Math.max(0, Date.now() - sessionTaskState.taskStartTime)
            : undefined,
        agent: agentDisplayName,
      };

      const strategy = createReplyStrategy({
        config: strategyConfig,
        card: currentAICard,
        useCardMode: replyMode === "card",
        to,
        sessionWebhook,
        senderId,
        isDirect,
        accountId,
        storePath: accountStorePath,
        sessionKey: route.sessionKey,
        sessionAgentId: route.agentId,
        disableBlockStreaming: shouldDisableBlockStreamingForReplyMode({
          replyMode,
          sessionKey: route.sessionKey,
          reasoningLevel: sessionReasoningLevel,
          log,
        }),
        groupId,
        log,
        replyQuotedRef,
        deliverMedia: deliverMediaAttachments,
        isStopRequested: isCurrentCardStopRequested,
        inboundText: rawInboundText,
        taskMeta,
      });

      try {
        let deliveredFinalCount = 0;
        const dispatchResult = await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx,
          cfg,
          dispatcherOptions: {
            responsePrefix: subAgentOptions?.responsePrefix || "",
            deliver: async (payload: ReplyStreamPayload, info?: ReplyChunkInfo) => {
              if (isCurrentCardStopRequested()) {
                log?.debug?.(
                  "[DingTalk][CardStop] Ignoring reply delivery because stop was already requested",
                );
                return;
              }
              try {
                if (info?.kind === "final") {
                  deliveredFinalCount += 1;
                }
                const inlineReplyPayload = parseInlineReplyPayloadText(payload.text);
                const mediaUrls = extractMediaUrls(payload, inlineReplyPayload);
                const richPayload = payload as ReplyStreamPayload & { isReasoning?: boolean };
                const replyKind = (info?.kind as DeliverPayload["kind"]) || "block";
                if (questionCardTookOver) {
                  log?.info?.(
                    `[DingTalk][AskUser] Suppressed ${replyKind} reply after question card took over`,
                  );
                  return;
                }
                await strategy.deliver({
                  text: inlineReplyPayload.text,
                  mediaUrls,
                  audioAsVoice: extractSharedAudioAsVoice(payload, inlineReplyPayload),
                  kind: replyKind,
                  isError: payload.isError === true,
                  isReasoning: richPayload.isReasoning === true,
                });
              } catch (err: unknown) {
                log?.error?.(`[DingTalk] Reply failed: ${getErrorMessage(err)}`);
                const responseData = getErrorResponseData(err);
                if (responseData !== undefined) {
                  log?.error?.(formatDingTalkErrorPayloadLog("inbound.replyDeliver", responseData));
                }
                throw err;
              }
            },
          },
          replyOptions: strategy.getReplyOptions(),
        });

        const bufferedFinal =
          dispatchResult && typeof dispatchResult === "object" && "queuedFinal" in dispatchResult
            ? (dispatchResult as { queuedFinal?: unknown }).queuedFinal
            : undefined;
        const finalCount =
          dispatchResult && typeof dispatchResult === "object" && "counts" in dispatchResult
            ? (dispatchResult as { counts?: { final?: unknown } }).counts?.final
            : undefined;

        log?.info?.(
          `[DingTalk][Dispatch] completed — deliveredFinalCount=${deliveredFinalCount} ` +
            `counts.final=${typeof finalCount === "number" ? finalCount : "n/a"} ` +
            `queuedFinalType=${typeof bufferedFinal}`,
        );

        const bufferedFinalPayload =
          typeof bufferedFinal === "string"
            ? ({ text: bufferedFinal } satisfies ReplyStreamPayload)
            : bufferedFinal && typeof bufferedFinal === "object"
              ? (bufferedFinal as ReplyStreamPayload)
              : undefined;

        if (deliveredFinalCount === 0 && bufferedFinalPayload) {
          const inlineReplyPayload = parseInlineReplyPayloadText(bufferedFinalPayload.text);
          const mediaUrls = extractMediaUrls(bufferedFinalPayload, inlineReplyPayload);
          const hasBufferedText =
            typeof bufferedFinalPayload.text === "string" &&
            bufferedFinalPayload.text.trim().length > 0;
          if (hasBufferedText || mediaUrls.length > 0) {
            if (questionCardTookOver) {
              log?.info?.(
                "[DingTalk][AskUser] Suppressed buffered final after question card took over",
              );
            } else {
              await strategy.deliver({
                text: inlineReplyPayload.text,
                mediaUrls,
                audioAsVoice: extractSharedAudioAsVoice(bufferedFinalPayload, inlineReplyPayload),
                kind: "final",
                isReasoning: bufferedFinalPayload.isReasoning === true,
              });
            }
          }
        }
      } catch (dispatchErr: unknown) {
        const error =
          dispatchErr instanceof Error ? dispatchErr : new Error(getErrorMessage(dispatchErr));
        await strategy.abort(error);
        throw dispatchErr;
      }

      if (questionCardTookOver) {
        log?.info?.(
          "[DingTalk][AskUser] Skipping normal AI card finalize after question card took over",
        );
        return;
      }
      await strategy.finalize();
    } finally {
      // Only remove the registry entry if no stop was requested. When a stop is
      // in progress, card-stop-handler may still be running async operations
      // (finalize card, hide button, gateway abort) that read the record.
      // In that case, let the 30-minute TTL sweep handle cleanup.
      if (currentOutTrackId && !isCardRunStopRequested(currentOutTrackId)) {
        removeCardRun(currentOutTrackId);
      }
      await waitForDynamicAckDispose({
        dispose: () => dynamicAckReactionController.dispose(MIN_THINKING_REACTION_VISIBLE_MS),
        log,
        sessionKey: route.sessionKey,
      });
      releaseSessionLock();
    }
  } finally {
    if (cardFlightKey) {
      cardCreationInFlight.delete(cardFlightKey);
    }
  }
}
