import { randomUUID } from "node:crypto";
import { readNamespaceJson, writeNamespaceJsonAtomic } from "./persistence-store";
import type { AttachmentTextSource, Logger, QuotedRef } from "./types";

const MESSAGE_CONTEXT_NAMESPACE = "messages.context";
const MESSAGE_CONTEXT_VERSION = 1;
export const DEFAULT_MESSAGE_CONTEXT_TTL_DAYS = 7;
export const DEFAULT_CARD_CONTENT_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MEDIA_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CREATED_AT_MATCH_WINDOW_MS = 2000;
const MAX_RECORDS_PER_SCOPE = 1000;

export type MessageContextDirection = "inbound" | "outbound";
export type MessageAliasKind =
  | "inboundMsgId"
  | "messageId"
  | "processQueryKey"
  | "outTrackId"
  | "cardInstanceId";
export type MessageDeliveryKind =
  | "session"
  | "proactive-text"
  | "proactive-card"
  | "proactive-media";
export const DEFAULT_OUTBOUND_SENDER = {
  senderId: "bot",
  senderName: "OpenClaw",
} as const;

/** DingTalk conversation ids usually start with "cid" for group chats; treat this as a heuristic. */
export function inferConversationChatType(conversationId: string): "direct" | "group" {
  return conversationId.startsWith("cid") ? "group" : "direct";
}

export interface MessageRecord {
  msgId: string;
  direction: MessageContextDirection;
  topic: string | null;
  accountId: string;
  conversationId: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  messageType?: string;
  text?: string;
  attachmentText?: string;
  attachmentTextSource?: AttachmentTextSource;
  attachmentTextTruncated?: boolean;
  attachmentFileName?: string;
  quotedRef?: QuotedRef;
  senderId?: string;
  senderName?: string;
  mentions?: string[];
  /** Raw DingTalk user IDs from structured @mention payloads. */
  mentionUserIds?: string[];
  chatType?: "direct" | "group";
  /** Flat quoted target for summary/history lookups; quotedRef remains the authoritative structured link. */
  quotedMessageId?: string;
  media?: {
    downloadCode?: string;
    downloadCodes?: string[];
    spaceId?: string;
    fileId?: string;
  };
  delivery?: {
    messageId?: string;
    processQueryKey?: string;
    outTrackId?: string;
    cardInstanceId?: string;
    kind?: MessageDeliveryKind;
  };
}

interface MessageContextState {
  version: number;
  updatedAt: number;
  records: Record<string, MessageRecord>;
  byAlias: Record<string, string>;
  recentByCreatedAt: string[];
}

interface PersistedMessageContextState {
  version: number;
  updatedAt: number;
  records: Record<string, MessageRecord>;
}

interface BaseUpsertParams {
  storePath?: string;
  accountId: string;
  conversationId: string | null;
  createdAt: number;
  updatedAt?: number;
  ttlMs?: number;
  ttlReferenceMs?: number;
  topic?: string | null;
  messageType?: string;
  text?: string;
  attachmentText?: string;
  attachmentTextSource?: AttachmentTextSource;
  attachmentTextTruncated?: boolean;
  attachmentFileName?: string;
  quotedRef?: QuotedRef;
  senderId?: string;
  senderName?: string;
  mentions?: string[];
  /** Raw DingTalk user IDs from structured @mention payloads. */
  mentionUserIds?: string[];
  chatType?: "direct" | "group";
  quotedMessageId?: string;
  media?: {
    downloadCode?: string;
    downloadCodes?: string[];
    spaceId?: string;
    fileId?: string;
  };
}

export interface UpsertInboundMessageContextParams extends BaseUpsertParams {
  msgId: string;
  cleanupCreatedAtTtlDays?: number;
}

export interface UpsertOutboundMessageContextParams extends BaseUpsertParams {
  msgId?: string;
  delivery?: MessageRecord["delivery"];
}

interface ScopeParams {
  storePath?: string;
  accountId: string;
  conversationId: string | null;
}

const stateCache = new Map<string, MessageContextState>();

function getScopeKey(params: ScopeParams): string {
  return JSON.stringify([
    params.storePath || "__memory__",
    params.accountId,
    params.conversationId || null,
  ]);
}

function fallbackState(): MessageContextState {
  return {
    version: MESSAGE_CONTEXT_VERSION,
    updatedAt: Date.now(),
    records: {},
    byAlias: {},
    recentByCreatedAt: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeMedia(value: unknown): MessageRecord["media"] | undefined {
  const candidate = asRecord(value);
  if (!candidate) {
    return undefined;
  }
  const downloadCode =
    typeof candidate.downloadCode === "string" && candidate.downloadCode.trim()
      ? candidate.downloadCode.trim()
      : undefined;
  const downloadCodes =
    Array.isArray(candidate.downloadCodes) && candidate.downloadCodes.length > 0
      ? candidate.downloadCodes.filter((c: unknown) => typeof c === "string" && c.trim())
      : undefined;
  const spaceId =
    typeof candidate.spaceId === "string" && candidate.spaceId.trim()
      ? candidate.spaceId.trim()
      : undefined;
  const fileId =
    typeof candidate.fileId === "string" && candidate.fileId.trim()
      ? candidate.fileId.trim()
      : undefined;
  if (!downloadCode && (!downloadCodes || downloadCodes.length === 0) && !spaceId && !fileId) {
    return undefined;
  }
  return { downloadCode, downloadCodes, spaceId, fileId };
}

function normalizeQuotedRef(value: unknown): QuotedRef | undefined {
  const candidate = asRecord(value);
  if (!candidate) {
    return undefined;
  }
  const targetDirection =
    candidate.targetDirection === "outbound"
      ? "outbound"
      : candidate.targetDirection === "inbound"
        ? "inbound"
        : undefined;
  const key =
    candidate.key === "msgId" ||
    candidate.key === "messageId" ||
    candidate.key === "processQueryKey" ||
    candidate.key === "outTrackId" ||
    candidate.key === "cardInstanceId"
      ? candidate.key
      : undefined;
  const valueString =
    typeof candidate.value === "string" && candidate.value.trim()
      ? candidate.value.trim()
      : undefined;
  const fallbackCreatedAt =
    typeof candidate.fallbackCreatedAt === "number" && Number.isFinite(candidate.fallbackCreatedAt)
      ? candidate.fallbackCreatedAt
      : undefined;
  if (!targetDirection) {
    return undefined;
  }
  if (!key && !fallbackCreatedAt) {
    return undefined;
  }
  if (key && !valueString) {
    return undefined;
  }
  return {
    targetDirection,
    key,
    value: valueString,
    fallbackCreatedAt,
  };
}

function normalizeAttachmentTextSource(value: unknown): AttachmentTextSource | undefined {
  return value === "text" || value === "html" || value === "pdf" || value === "docx"
    ? value
    : undefined;
}

function normalizeDelivery(value: unknown): MessageRecord["delivery"] | undefined {
  const candidate = asRecord(value);
  if (!candidate) {
    return undefined;
  }
  const messageId =
    typeof candidate.messageId === "string" && candidate.messageId.trim()
      ? candidate.messageId.trim()
      : undefined;
  const processQueryKey =
    typeof candidate.processQueryKey === "string" && candidate.processQueryKey.trim()
      ? candidate.processQueryKey.trim()
      : undefined;
  const outTrackId =
    typeof candidate.outTrackId === "string" && candidate.outTrackId.trim()
      ? candidate.outTrackId.trim()
      : undefined;
  const cardInstanceId =
    typeof candidate.cardInstanceId === "string" && candidate.cardInstanceId.trim()
      ? candidate.cardInstanceId.trim()
      : undefined;
  const kind =
    typeof candidate.kind === "string" && candidate.kind.trim()
      ? (candidate.kind.trim() as MessageDeliveryKind)
      : undefined;
  if (!messageId && !processQueryKey && !outTrackId && !cardInstanceId && !kind) {
    return undefined;
  }
  return { messageId, processQueryKey, outTrackId, cardInstanceId, kind };
}

function normalizeMentions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  // Preserve the original mention token casing because DingTalk ids may be case-sensitive.
  const normalized = [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeMessageRecord(value: unknown): MessageRecord | null {
  const candidate = asRecord(value);
  if (!candidate) {
    return null;
  }
  const msgId =
    typeof candidate.msgId === "string" && candidate.msgId.trim() ? candidate.msgId.trim() : "";
  const direction =
    candidate.direction === "outbound"
      ? "outbound"
      : candidate.direction === "inbound"
        ? "inbound"
        : null;
  const accountId =
    typeof candidate.accountId === "string" && candidate.accountId.trim()
      ? candidate.accountId.trim()
      : "";
  const conversationId =
    typeof candidate.conversationId === "string" && candidate.conversationId.trim()
      ? candidate.conversationId.trim()
      : null;
  const createdAt =
    typeof candidate.createdAt === "number" && Number.isFinite(candidate.createdAt)
      ? candidate.createdAt
      : NaN;
  const updatedAt =
    typeof candidate.updatedAt === "number" && Number.isFinite(candidate.updatedAt)
      ? candidate.updatedAt
      : Date.now();
  if (!msgId || !direction || !accountId || !Number.isFinite(createdAt)) {
    return null;
  }
  const expiresAt =
    typeof candidate.expiresAt === "number" && Number.isFinite(candidate.expiresAt)
      ? candidate.expiresAt
      : undefined;
  return {
    msgId,
    direction,
    topic:
      candidate.topic === null
        ? null
        : typeof candidate.topic === "string"
          ? candidate.topic
          : null,
    accountId,
    conversationId,
    createdAt,
    updatedAt,
    expiresAt,
    messageType: typeof candidate.messageType === "string" ? candidate.messageType : undefined,
    text: typeof candidate.text === "string" ? candidate.text : undefined,
    attachmentText:
      typeof candidate.attachmentText === "string" ? candidate.attachmentText : undefined,
    attachmentTextSource: normalizeAttachmentTextSource(candidate.attachmentTextSource),
    attachmentTextTruncated: candidate.attachmentTextTruncated === true ? true : undefined,
    attachmentFileName:
      typeof candidate.attachmentFileName === "string" ? candidate.attachmentFileName : undefined,
    quotedRef: normalizeQuotedRef(candidate.quotedRef),
    senderId:
      typeof candidate.senderId === "string" && candidate.senderId.trim()
        ? candidate.senderId.trim()
        : undefined,
    senderName:
      typeof candidate.senderName === "string" && candidate.senderName.trim()
        ? candidate.senderName.trim()
        : undefined,
    mentions: normalizeMentions(candidate.mentions),
    mentionUserIds: normalizeMentions(candidate.mentionUserIds),
    chatType:
      candidate.chatType === "direct" || candidate.chatType === "group"
        ? candidate.chatType
        : undefined,
    quotedMessageId:
      typeof candidate.quotedMessageId === "string" && candidate.quotedMessageId.trim()
        ? candidate.quotedMessageId.trim()
        : undefined,
    media: normalizeMedia(candidate.media),
    delivery: normalizeDelivery(candidate.delivery),
  };
}

function buildAliasKey(kind: MessageAliasKind, value: string): string {
  return `${kind}:${value.trim()}`;
}

function buildAliasEntries(record: MessageRecord): Array<[string, string]> {
  const aliases: Array<[string, string]> = [];
  if (record.direction === "inbound" && record.msgId.trim()) {
    aliases.push([buildAliasKey("inboundMsgId", record.msgId), record.msgId]);
  }
  const delivery = record.delivery;
  if (!delivery) {
    return aliases;
  }
  if (delivery.messageId) {
    aliases.push([buildAliasKey("messageId", delivery.messageId), record.msgId]);
  }
  if (delivery.processQueryKey) {
    aliases.push([buildAliasKey("processQueryKey", delivery.processQueryKey), record.msgId]);
  }
  if (delivery.outTrackId) {
    aliases.push([buildAliasKey("outTrackId", delivery.outTrackId), record.msgId]);
  }
  if (delivery.cardInstanceId) {
    aliases.push([buildAliasKey("cardInstanceId", delivery.cardInstanceId), record.msgId]);
  }
  return aliases;
}

function isRecordExpired(record: MessageRecord, nowMs: number): boolean {
  return (
    typeof record.expiresAt === "number" &&
    Number.isFinite(record.expiresAt) &&
    nowMs >= record.expiresAt
  );
}

function normalizeState(
  state: MessageContextState,
  nowMs: number,
): { state: MessageContextState; removed: number } {
  const normalizedRecords: Record<string, MessageRecord> = {};
  const sortedRecords = Object.values(state.records)
    .map((record) => normalizeMessageRecord(record))
    .filter((record): record is MessageRecord => record !== null)
    .filter((record) => !isRecordExpired(record, nowMs))
    .toSorted((left, right) => left.createdAt - right.createdAt);
  const keptRecords = sortedRecords.slice(-MAX_RECORDS_PER_SCOPE);
  for (const record of keptRecords) {
    normalizedRecords[record.msgId] = record;
  }
  const byAlias: Record<string, string> = {};
  for (const record of keptRecords) {
    for (const [key, value] of buildAliasEntries(record)) {
      byAlias[key] = value;
    }
  }
  return {
    removed: Object.keys(state.records).length - Object.keys(normalizedRecords).length,
    state: {
      version: MESSAGE_CONTEXT_VERSION,
      updatedAt: state.updatedAt,
      records: normalizedRecords,
      byAlias,
      recentByCreatedAt: keptRecords.map((record) => record.msgId),
    },
  };
}

function hydrateState(params: ScopeParams, nowMs: number): MessageContextState {
  if (!params.storePath) {
    return fallbackState();
  }
  const persisted = readNamespaceJson<Partial<PersistedMessageContextState>>(
    MESSAGE_CONTEXT_NAMESPACE,
    {
      storePath: params.storePath,
      scope: { accountId: params.accountId, conversationId: params.conversationId || undefined },
      format: "json",
      fallback: { version: MESSAGE_CONTEXT_VERSION, updatedAt: Date.now(), records: {} },
    },
  );
  const parsedRecords = asRecord(persisted.records) || {};
  const hydrated = fallbackState();
  hydrated.updatedAt = typeof persisted.updatedAt === "number" ? persisted.updatedAt : Date.now();
  for (const [key, value] of Object.entries(parsedRecords)) {
    const normalized = normalizeMessageRecord(value);
    if (normalized) {
      hydrated.records[key] = normalized;
    }
  }
  return normalizeState(hydrated, nowMs).state;
}

function loadState(params: ScopeParams, nowMs: number = Date.now()): MessageContextState {
  const scopeKey = getScopeKey(params);
  const cached = stateCache.get(scopeKey);
  if (cached) {
    return cached;
  }
  const hydrated = params.storePath ? hydrateState(params, nowMs) : fallbackState();
  stateCache.set(scopeKey, hydrated);
  return hydrated;
}

function writeState(params: ScopeParams, state: MessageContextState): void {
  stateCache.set(getScopeKey(params), state);
  if (!params.storePath) {
    return;
  }
  writeNamespaceJsonAtomic(MESSAGE_CONTEXT_NAMESPACE, {
    storePath: params.storePath,
    scope: { accountId: params.accountId, conversationId: params.conversationId || undefined },
    format: "json",
    data: {
      version: MESSAGE_CONTEXT_VERSION,
      updatedAt: state.updatedAt,
      records: state.records,
    } satisfies PersistedMessageContextState,
  });
}

function cloneStateForMutation(state: MessageContextState): MessageContextState {
  return {
    version: state.version,
    updatedAt: state.updatedAt,
    records: { ...state.records },
    byAlias: state.byAlias,
    recentByCreatedAt: state.recentByCreatedAt,
  };
}

function mergeText(existing: string | undefined, next: string | undefined): string | undefined {
  if (typeof next !== "string") {
    return existing;
  }
  return next;
}

function mergeAttachmentText(
  existing: string | undefined,
  next: string | undefined,
): string | undefined {
  if (typeof next !== "string") {
    return existing;
  }
  return next;
}

function mergeQuotedRef(
  existing: QuotedRef | undefined,
  next: QuotedRef | undefined,
): QuotedRef | undefined {
  if (!existing) {
    return next;
  }
  if (!next) {
    return existing;
  }
  return {
    targetDirection: next.targetDirection,
    key: next.key || existing.key,
    value: next.value || existing.value,
    fallbackCreatedAt: next.fallbackCreatedAt ?? existing.fallbackCreatedAt,
  };
}

function mergeStringField(
  existing: string | undefined,
  next: string | undefined,
): string | undefined {
  if (typeof next !== "string" || !next.trim()) {
    return existing;
  }
  return next.trim();
}

function mergeMentions(
  existing: string[] | undefined,
  next: string[] | undefined,
): string[] | undefined {
  if (!next) {
    return existing;
  }
  return normalizeMentions(next) || existing;
}

function mergeMedia(
  existing: MessageRecord["media"] | undefined,
  next: MessageRecord["media"] | undefined,
): MessageRecord["media"] | undefined {
  if (!existing) {
    return next;
  }
  if (!next) {
    return existing;
  }
  return {
    downloadCode: next.downloadCode || existing.downloadCode,
    downloadCodes: next.downloadCodes || existing.downloadCodes,
    spaceId: next.spaceId || existing.spaceId,
    fileId: next.fileId || existing.fileId,
  };
}

function mergeDelivery(
  existing: MessageRecord["delivery"] | undefined,
  next: MessageRecord["delivery"] | undefined,
): MessageRecord["delivery"] | undefined {
  if (!existing) {
    return next;
  }
  if (!next) {
    return existing;
  }
  return {
    messageId: next.messageId || existing.messageId,
    processQueryKey: next.processQueryKey || existing.processQueryKey,
    outTrackId: next.outTrackId || existing.outTrackId,
    cardInstanceId: next.cardInstanceId || existing.cardInstanceId,
    kind: next.kind || existing.kind,
  };
}

function mergeAttachmentTextSource(
  existing: AttachmentTextSource | undefined,
  next: AttachmentTextSource | undefined,
): AttachmentTextSource | undefined {
  return next ?? existing;
}

function mergeAttachmentTextTruncated(
  existing: boolean | undefined,
  next: boolean | undefined,
): boolean | undefined {
  return next === undefined ? existing : next;
}

function mergeAttachmentFileName(
  existing: string | undefined,
  next: string | undefined,
): string | undefined {
  if (typeof next !== "string") {
    return existing;
  }
  return next;
}

function resolveExistingMsgId(
  state: MessageContextState,
  params: {
    direction: MessageContextDirection;
    msgId?: string;
    delivery?: MessageRecord["delivery"];
  },
  nowMs: number,
): string | undefined {
  if (params.direction === "inbound" && params.msgId) {
    const direct = state.records[params.msgId];
    if (direct && !isRecordExpired(direct, nowMs)) {
      return params.msgId;
    }
  }
  const delivery = params.delivery;
  if (!delivery) {
    return undefined;
  }
  const candidates: Array<[MessageAliasKind, string | undefined]> = [
    ["messageId", delivery.messageId],
    ["processQueryKey", delivery.processQueryKey],
    ["outTrackId", delivery.outTrackId],
    ["cardInstanceId", delivery.cardInstanceId],
  ];
  for (const [kind, value] of candidates) {
    if (!value) {
      continue;
    }
    const aliasHit = state.byAlias[buildAliasKey(kind, value)];
    if (!aliasHit) {
      continue;
    }
    const record = state.records[aliasHit];
    if (record && !isRecordExpired(record, nowMs)) {
      return aliasHit;
    }
  }
  return undefined;
}

function computeExpiresAt(
  nowMs: number,
  ttlMs?: number,
  ttlReferenceMs?: number,
): number | undefined {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return undefined;
  }
  return (
    (typeof ttlReferenceMs === "number" && Number.isFinite(ttlReferenceMs)
      ? ttlReferenceMs
      : nowMs) + ttlMs
  );
}

function pruneStateByCreatedAt(
  state: MessageContextState,
  ttlDays: number,
  nowMs: number,
): { state: MessageContextState; removed: number } {
  if (!ttlDays || ttlDays <= 0) {
    return { state, removed: 0 };
  }
  const cutoff = nowMs - ttlDays * 24 * 60 * 60 * 1000;
  const nextRecords: Record<string, MessageRecord> = {};
  for (const [msgId, record] of Object.entries(state.records)) {
    if (record.createdAt >= cutoff) {
      nextRecords[msgId] = record;
    }
  }
  const removed = Object.keys(state.records).length - Object.keys(nextRecords).length;
  if (removed === 0) {
    return { state, removed: 0 };
  }
  return {
    removed,
    state: {
      ...state,
      records: nextRecords,
    },
  };
}

function upsertRecord(
  params: ScopeParams & {
    direction: MessageContextDirection;
    msgId?: string;
    createdAt: number;
    updatedAt?: number;
    topic?: string | null;
    ttlMs?: number;
    ttlReferenceMs?: number;
    messageType?: string;
    text?: string;
    attachmentText?: string;
    attachmentTextSource?: AttachmentTextSource;
    attachmentTextTruncated?: boolean;
    attachmentFileName?: string;
    quotedRef?: QuotedRef;
    senderId?: string;
    senderName?: string;
    mentions?: string[];
    mentionUserIds?: string[];
    chatType?: "direct" | "group";
    quotedMessageId?: string;
    media?: MessageRecord["media"];
    delivery?: MessageRecord["delivery"];
    cleanupCreatedAtTtlDays?: number;
  },
): string | undefined {
  const nowMs = params.updatedAt ?? Date.now();
  let state = cloneStateForMutation(loadState(params, nowMs));
  if (params.cleanupCreatedAtTtlDays && params.cleanupCreatedAtTtlDays > 0) {
    state = pruneStateByCreatedAt(state, params.cleanupCreatedAtTtlDays, nowMs).state;
  }
  const existingMsgId = resolveExistingMsgId(
    state,
    {
      direction: params.direction,
      msgId: params.msgId,
      delivery: params.delivery,
    },
    nowMs,
  );
  const canonicalMsgId =
    existingMsgId ||
    params.msgId ||
    params.delivery?.messageId ||
    params.delivery?.processQueryKey ||
    params.delivery?.outTrackId;
  if (!canonicalMsgId || !canonicalMsgId.trim()) {
    return undefined;
  }
  const existing = state.records[canonicalMsgId];
  const expiresAt = computeExpiresAt(nowMs, params.ttlMs, params.ttlReferenceMs);
  const normalizedQuotedRef = normalizeQuotedRef(params.quotedRef);
  state.records[canonicalMsgId] = {
    msgId: canonicalMsgId,
    direction: params.direction,
    topic: params.topic ?? existing?.topic ?? null,
    accountId: params.accountId,
    conversationId: params.conversationId,
    createdAt: existing?.createdAt ?? params.createdAt,
    updatedAt: nowMs,
    expiresAt:
      expiresAt === undefined ? existing?.expiresAt : Math.max(expiresAt, existing?.expiresAt ?? 0),
    messageType: params.messageType || existing?.messageType,
    text: mergeText(existing?.text, params.text),
    attachmentText: mergeAttachmentText(existing?.attachmentText, params.attachmentText),
    attachmentTextSource: mergeAttachmentTextSource(
      existing?.attachmentTextSource,
      params.attachmentTextSource,
    ),
    attachmentTextTruncated: mergeAttachmentTextTruncated(
      existing?.attachmentTextTruncated,
      params.attachmentTextTruncated,
    ),
    attachmentFileName: mergeAttachmentFileName(
      existing?.attachmentFileName,
      params.attachmentFileName,
    ),
    quotedRef: mergeQuotedRef(existing?.quotedRef, normalizedQuotedRef),
    senderId: mergeStringField(existing?.senderId, params.senderId),
    senderName: mergeStringField(existing?.senderName, params.senderName),
    mentions: mergeMentions(existing?.mentions, params.mentions),
    mentionUserIds: mergeMentions(existing?.mentionUserIds, params.mentionUserIds),
    chatType: params.chatType || existing?.chatType,
    quotedMessageId: mergeStringField(existing?.quotedMessageId, params.quotedMessageId),
    media: mergeMedia(existing?.media, params.media),
    delivery: mergeDelivery(existing?.delivery, params.delivery),
  };
  state.updatedAt = nowMs;
  writeState(params, normalizeState(state, nowMs).state);
  return canonicalMsgId;
}

export function upsertInboundMessageContext(params: UpsertInboundMessageContextParams): string {
  return (
    upsertRecord({
      ...params,
      direction: "inbound",
      topic: params.topic ?? null,
      msgId: params.msgId,
      cleanupCreatedAtTtlDays: params.cleanupCreatedAtTtlDays,
    }) || params.msgId
  );
}

export function upsertOutboundMessageContext(
  params: UpsertOutboundMessageContextParams,
): string | undefined {
  return upsertRecord({
    ...params,
    direction: "outbound",
    topic: params.topic ?? null,
  });
}

export function createSyntheticOutboundMsgId(createdAt: number): string {
  return `createdAt:${createdAt}:${randomUUID()}`;
}

export function resolveByMsgId(
  params: ScopeParams & { msgId: string; nowMs?: number },
): MessageRecord | null {
  const nowMs = params.nowMs ?? Date.now();
  const state = loadState(params, nowMs);
  const direct = state.records[params.msgId];
  if (direct && !isRecordExpired(direct, nowMs)) {
    return direct;
  }
  const aliasTarget = state.byAlias[buildAliasKey("inboundMsgId", params.msgId)];
  if (!aliasTarget) {
    return null;
  }
  const record = state.records[aliasTarget];
  return record && !isRecordExpired(record, nowMs) ? record : null;
}

export function resolveByAlias(
  params: ScopeParams & { kind: MessageAliasKind; value: string; nowMs?: number },
): MessageRecord | null {
  const nowMs = params.nowMs ?? Date.now();
  const state = loadState(params, nowMs);
  const msgId = state.byAlias[buildAliasKey(params.kind, params.value)];
  if (!msgId) {
    return null;
  }
  const record = state.records[msgId];
  return record && !isRecordExpired(record, nowMs) ? record : null;
}

export function resolveByQuotedRef(
  params: ScopeParams & { quotedRef: QuotedRef; nowMs?: number; log?: Logger },
): MessageRecord | null {
  const nowMs = params.nowMs ?? Date.now();
  const quotedRef = normalizeQuotedRef(params.quotedRef);
  const log = params.log;
  if (!quotedRef) {
    log?.debug?.(
      `[DingTalk][QuotedRef] Resolve skipped: invalid quotedRef accountId=${params.accountId} conversationId=${params.conversationId || "(none)"}`,
    );
    return null;
  }
  if (quotedRef.targetDirection === "inbound") {
    if (quotedRef.key !== "msgId" || !quotedRef.value) {
      log?.debug?.(
        `[DingTalk][QuotedRef] Resolve skipped: inbound quotedRef missing msgId accountId=${params.accountId} conversationId=${params.conversationId || "(none)"}`,
      );
      return null;
    }
    const record = resolveByMsgId({
      ...params,
      msgId: quotedRef.value,
      nowMs,
    });
    log?.debug?.(
      `[DingTalk][QuotedRef] Resolve inbound by msgId=${quotedRef.value} hit=${record ? "yes" : "no"} accountId=${params.accountId} conversationId=${params.conversationId || "(none)"}`,
    );
    return record;
  }
  if (quotedRef.key && quotedRef.value && quotedRef.key !== "msgId") {
    const aliasRecord = resolveByAlias({
      ...params,
      kind: quotedRef.key,
      value: quotedRef.value,
      nowMs,
    });
    if (aliasRecord) {
      log?.debug?.(
        `[DingTalk][QuotedRef] Resolve outbound by ${quotedRef.key}=${quotedRef.value} hit=yes accountId=${params.accountId} conversationId=${params.conversationId || "(none)"}`,
      );
      return aliasRecord;
    }
    log?.debug?.(
      `[DingTalk][QuotedRef] Resolve outbound by ${quotedRef.key}=${quotedRef.value} hit=no accountId=${params.accountId} conversationId=${params.conversationId || "(none)"}`,
    );
  }
  if (
    typeof quotedRef.fallbackCreatedAt === "number" &&
    Number.isFinite(quotedRef.fallbackCreatedAt)
  ) {
    const record = resolveByCreatedAtWindow({
      ...params,
      createdAt: quotedRef.fallbackCreatedAt,
      direction: "outbound",
      nowMs,
    });
    log?.debug?.(
      `[DingTalk][QuotedRef] Resolve outbound by createdAt=${quotedRef.fallbackCreatedAt} hit=${record ? "yes" : "no"} accountId=${params.accountId} conversationId=${params.conversationId || "(none)"}`,
    );
    return record;
  }
  log?.debug?.(
    `[DingTalk][QuotedRef] Resolve outbound missed without createdAt fallback accountId=${params.accountId} conversationId=${params.conversationId || "(none)"}`,
  );
  return null;
}

export function resolveByCreatedAtWindow(
  params: ScopeParams & {
    createdAt: number;
    windowMs?: number;
    direction?: MessageContextDirection;
    nowMs?: number;
  },
): MessageRecord | null {
  const nowMs = params.nowMs ?? Date.now();
  const windowMs = params.windowMs ?? DEFAULT_CREATED_AT_MATCH_WINDOW_MS;
  const state = loadState(params, nowMs);
  let bestRecord: MessageRecord | null = null;
  let bestDelta = Infinity;
  for (const msgId of state.recentByCreatedAt) {
    const record = state.records[msgId];
    if (!record || isRecordExpired(record, nowMs)) {
      continue;
    }
    if (params.direction && record.direction !== params.direction) {
      continue;
    }
    const delta = Math.abs(record.createdAt - params.createdAt);
    if (delta <= windowMs && delta < bestDelta) {
      bestDelta = delta;
      bestRecord = record;
    }
  }
  return bestRecord;
}

export function cleanupExpiredMessageContexts(params: ScopeParams & { nowMs?: number }): number {
  const nowMs = params.nowMs ?? Date.now();
  const state = loadState(params, nowMs);
  const beforeCount = Object.keys(state.records).length;
  const normalized = normalizeState(state, nowMs).state;
  const removed = beforeCount - Object.keys(normalized.records).length;
  if (removed > 0) {
    normalized.updatedAt = nowMs;
    writeState(params, normalized);
  }
  return removed;
}

export function clearMessageContextCacheForTest(): void {
  stateCache.clear();
}

/**
 * Lists non-expired message-context records for one account/conversation scope in createdAt ascending order.
 */
export function listMessageContexts(params: ScopeParams & { nowMs?: number }): MessageRecord[] {
  const nowMs = params.nowMs ?? Date.now();
  const state = loadState(params, nowMs);
  return state.recentByCreatedAt
    .map((msgId) => state.records[msgId])
    .filter(
      (record): record is MessageRecord => Boolean(record) && !isRecordExpired(record, nowMs),
    );
}
