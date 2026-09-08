import { readNamespaceJson, writeNamespaceJsonAtomic } from "../persistence-store";

const TARGET_DIRECTORY_NAMESPACE = "targets.directory";
const MAX_HISTORICAL_NAMES = 20;
const MAX_RECENT_CONVERSATIONS = 20;
const LAST_SEEN_WRITE_THROTTLE_MS = 60 * 1000;

export interface GroupTargetEntry {
  conversationId: string;
  currentTitle: string;
  historicalTitles: string[];
  lastSeenAt: number;
}

export interface UserTargetEntry {
  canonicalUserId: string;
  staffId?: string;
  senderId: string;
  currentDisplayName: string;
  historicalDisplayNames: string[];
  lastSeenAt: number;
  lastSeenInConversationIds: string[];
}

interface TargetDirectoryState {
  version: 1;
  groups: Record<string, GroupTargetEntry>;
  users: Record<string, UserTargetEntry>;
}

const inMemoryFallbackState = new Map<string, TargetDirectoryState>();
const persistedStateCache = new Map<string, TargetDirectoryState>();

function fallbackState(): TargetDirectoryState {
  return {
    version: 1,
    groups: {},
    users: {},
  };
}

function trimValue(value: string | undefined): string {
  return String(value || "").trim();
}

function normalizeLookup(value: string | undefined): string {
  return trimValue(value).replace(/\s+/g, " ").toLowerCase();
}

function normalizeScopeKey(storePath: string | undefined, accountId: string): string {
  return JSON.stringify([storePath || "__memory__", accountId]);
}

function readState(params: { storePath?: string; accountId: string }): TargetDirectoryState {
  const scopeKey = normalizeScopeKey(params.storePath, params.accountId);
  if (!params.storePath) {
    return inMemoryFallbackState.get(scopeKey) || fallbackState();
  }
  const cached = persistedStateCache.get(scopeKey);
  if (cached) {
    return cached;
  }
  const state = readNamespaceJson<TargetDirectoryState>(TARGET_DIRECTORY_NAMESPACE, {
    storePath: params.storePath,
    scope: { accountId: params.accountId },
    fallback: fallbackState(),
  });
  persistedStateCache.set(scopeKey, state);
  return state;
}

function writeState(params: {
  storePath?: string;
  accountId: string;
  state: TargetDirectoryState;
}): void {
  const scopeKey = normalizeScopeKey(params.storePath, params.accountId);
  if (!params.storePath) {
    inMemoryFallbackState.set(scopeKey, params.state);
    return;
  }
  persistedStateCache.set(scopeKey, params.state);
  writeNamespaceJsonAtomic(TARGET_DIRECTORY_NAMESPACE, {
    storePath: params.storePath,
    scope: { accountId: params.accountId },
    data: params.state,
  });
}

export function clearTargetDirectoryStateCache(): void {
  inMemoryFallbackState.clear();
  persistedStateCache.clear();
}

function appendUniqueText(list: string[], value: string, maxSize: number): string[] {
  const normalized = normalizeLookup(value);
  if (!normalized) {
    return list;
  }
  const existingIndex = list.findIndex((item) => normalizeLookup(item) === normalized);
  if (existingIndex >= 0) {
    return list;
  }
  const nextList = [...list, value.trim()];
  return nextList.length > maxSize ? nextList.slice(nextList.length - maxSize) : nextList;
}

function appendUniqueRecentConversation(list: string[], value: string, maxSize: number): string[] {
  const normalized = normalizeLookup(value);
  if (!normalized) {
    return list;
  }
  const exists = list.some((item) => normalizeLookup(item) === normalized);
  if (exists) {
    return list;
  }
  const nextList = [...list, value.trim()];
  return nextList.length > maxSize ? nextList.slice(nextList.length - maxSize) : nextList;
}

function shouldRefreshLastSeen(
  existingLastSeen: number | undefined,
  nextLastSeen: number,
): boolean {
  const previous = Number.isFinite(existingLastSeen) ? Number(existingLastSeen) : 0;
  if (previous <= 0) {
    return true;
  }
  if (nextLastSeen <= previous) {
    return false;
  }
  return nextLastSeen - previous >= LAST_SEEN_WRITE_THROTTLE_MS;
}

function findUserKeyByIdentifiers(
  state: TargetDirectoryState,
  params: { canonicalUserId?: string; staffId?: string; senderId?: string },
): string | undefined {
  const canonical = normalizeLookup(params.canonicalUserId);
  if (canonical && state.users[params.canonicalUserId || ""]) {
    return params.canonicalUserId;
  }

  const staffNorm = normalizeLookup(params.staffId);
  const senderNorm = normalizeLookup(params.senderId);
  for (const [key, entry] of Object.entries(state.users)) {
    if (canonical && normalizeLookup(key) === canonical) {
      return key;
    }
    if (staffNorm && normalizeLookup(entry.staffId) === staffNorm) {
      return key;
    }
    if (senderNorm && normalizeLookup(entry.senderId) === senderNorm) {
      return key;
    }
  }
  return undefined;
}

export function upsertObservedGroupTarget(params: {
  storePath?: string;
  accountId: string;
  conversationId: string;
  title?: string;
  seenAt?: number;
}): void {
  const conversationId = trimValue(params.conversationId);
  if (!conversationId) {
    return;
  }
  const nowMs = params.seenAt && Number.isFinite(params.seenAt) ? params.seenAt : Date.now();
  const title = trimValue(params.title) || conversationId;
  const state = readState({ storePath: params.storePath, accountId: params.accountId });
  const existingEntry = state.groups[conversationId];

  if (!existingEntry) {
    const nextState: TargetDirectoryState = {
      ...state,
      groups: {
        ...state.groups,
        [conversationId]: {
          conversationId,
          currentTitle: title,
          historicalTitles: [],
          lastSeenAt: nowMs,
        },
      },
    };
    writeState({ storePath: params.storePath, accountId: params.accountId, state: nextState });
    return;
  }

  const titleChanged = normalizeLookup(existingEntry.currentTitle) !== normalizeLookup(title);
  const nextHistoricalTitles = titleChanged
    ? appendUniqueText(
        existingEntry.historicalTitles,
        existingEntry.currentTitle,
        MAX_HISTORICAL_NAMES,
      )
    : existingEntry.historicalTitles;
  const nextLastSeenCandidate = Math.max(existingEntry.lastSeenAt || 0, nowMs);
  const nextLastSeenAt =
    titleChanged || nextHistoricalTitles !== existingEntry.historicalTitles
      ? nextLastSeenCandidate
      : shouldRefreshLastSeen(existingEntry.lastSeenAt, nextLastSeenCandidate)
        ? nextLastSeenCandidate
        : existingEntry.lastSeenAt;

  if (
    !titleChanged &&
    nextHistoricalTitles === existingEntry.historicalTitles &&
    nextLastSeenAt === existingEntry.lastSeenAt
  ) {
    return;
  }

  const nextEntry: GroupTargetEntry = {
    conversationId,
    currentTitle: titleChanged ? title : existingEntry.currentTitle,
    historicalTitles: nextHistoricalTitles,
    lastSeenAt: nextLastSeenAt,
  };
  const nextState: TargetDirectoryState = {
    ...state,
    groups: {
      ...state.groups,
      [conversationId]: nextEntry,
    },
  };
  writeState({ storePath: params.storePath, accountId: params.accountId, state: nextState });
}

export function upsertObservedUserTarget(params: {
  storePath?: string;
  accountId: string;
  senderId: string;
  staffId?: string;
  displayName?: string;
  conversationId?: string;
  seenAt?: number;
}): void {
  const senderId = trimValue(params.senderId);
  if (!senderId) {
    return;
  }
  const staffId = trimValue(params.staffId);
  const canonicalUserId = staffId || senderId;
  const nowMs = params.seenAt && Number.isFinite(params.seenAt) ? params.seenAt : Date.now();
  const displayName = trimValue(params.displayName) || canonicalUserId;
  const conversationId = trimValue(params.conversationId);

  const state = readState({ storePath: params.storePath, accountId: params.accountId });
  const existingKey = findUserKeyByIdentifiers(state, {
    canonicalUserId,
    staffId,
    senderId,
  });
  const existingEntry = existingKey ? state.users[existingKey] : undefined;

  if (!existingEntry) {
    const nextState: TargetDirectoryState = {
      ...state,
      users: {
        ...state.users,
        [canonicalUserId]: {
          canonicalUserId,
          staffId: staffId || undefined,
          senderId,
          currentDisplayName: displayName,
          historicalDisplayNames: [],
          lastSeenAt: nowMs,
          lastSeenInConversationIds: conversationId ? [conversationId] : [],
        },
      },
    };
    writeState({ storePath: params.storePath, accountId: params.accountId, state: nextState });
    return;
  }

  const displayNameChanged =
    normalizeLookup(existingEntry.currentDisplayName) !== normalizeLookup(displayName);
  const nextHistoricalDisplayNames = displayNameChanged
    ? appendUniqueText(
        existingEntry.historicalDisplayNames,
        existingEntry.currentDisplayName,
        MAX_HISTORICAL_NAMES,
      )
    : existingEntry.historicalDisplayNames;
  const nextConversationIds = conversationId
    ? appendUniqueRecentConversation(
        existingEntry.lastSeenInConversationIds,
        conversationId,
        MAX_RECENT_CONVERSATIONS,
      )
    : existingEntry.lastSeenInConversationIds;
  const normalizedStaffId = staffId || undefined;
  const staffIdChanged = existingEntry.staffId !== normalizedStaffId;
  const senderIdChanged = existingEntry.senderId !== senderId;
  const canonicalUserIdChanged =
    existingEntry.canonicalUserId !== canonicalUserId || existingKey !== canonicalUserId;
  const metadataChanged =
    displayNameChanged ||
    nextHistoricalDisplayNames !== existingEntry.historicalDisplayNames ||
    nextConversationIds !== existingEntry.lastSeenInConversationIds ||
    staffIdChanged ||
    senderIdChanged ||
    canonicalUserIdChanged;
  const nextLastSeenCandidate = Math.max(existingEntry.lastSeenAt || 0, nowMs);
  const nextLastSeenAt = metadataChanged
    ? nextLastSeenCandidate
    : shouldRefreshLastSeen(existingEntry.lastSeenAt, nextLastSeenCandidate)
      ? nextLastSeenCandidate
      : existingEntry.lastSeenAt;

  if (!metadataChanged && nextLastSeenAt === existingEntry.lastSeenAt) {
    return;
  }

  const nextEntry: UserTargetEntry = {
    canonicalUserId,
    staffId: normalizedStaffId,
    senderId,
    currentDisplayName: displayNameChanged ? displayName : existingEntry.currentDisplayName,
    historicalDisplayNames: nextHistoricalDisplayNames,
    lastSeenAt: nextLastSeenAt,
    lastSeenInConversationIds: nextConversationIds,
  };

  const nextUsers =
    existingKey && existingKey !== canonicalUserId
      ? Object.fromEntries(Object.entries(state.users).filter(([key]) => key !== existingKey))
      : { ...state.users };
  nextUsers[canonicalUserId] = nextEntry;

  const nextState: TargetDirectoryState = {
    ...state,
    users: nextUsers,
  };
  writeState({ storePath: params.storePath, accountId: params.accountId, state: nextState });
}

function matchesGroupQuery(entry: GroupTargetEntry, query: string): boolean {
  const normalizedQuery = normalizeLookup(query);
  if (!normalizedQuery) {
    return true;
  }
  const candidates = [entry.conversationId, entry.currentTitle, ...entry.historicalTitles];
  return candidates.some((value) => normalizeLookup(value) === normalizedQuery);
}

function matchesUserQuery(entry: UserTargetEntry, query: string): boolean {
  const normalizedQuery = normalizeLookup(query);
  if (!normalizedQuery) {
    return true;
  }
  const candidates = [
    entry.canonicalUserId,
    entry.staffId || "",
    entry.senderId,
    entry.currentDisplayName,
    ...entry.historicalDisplayNames,
  ];
  return candidates.some((value) => normalizeLookup(value) === normalizedQuery);
}

export function listKnownGroupTargets(params: {
  storePath?: string;
  accountId: string;
  query?: string;
  limit?: number;
}): GroupTargetEntry[] {
  const state = readState({ storePath: params.storePath, accountId: params.accountId });
  const entries = Object.values(state.groups)
    .filter((entry) => matchesGroupQuery(entry, params.query || ""))
    .toSorted((a, b) => b.lastSeenAt - a.lastSeenAt);
  if (params.limit && params.limit > 0) {
    return entries.slice(0, params.limit);
  }
  return entries;
}

export function listKnownUserTargets(params: {
  storePath?: string;
  accountId: string;
  query?: string;
  limit?: number;
}): UserTargetEntry[] {
  const state = readState({ storePath: params.storePath, accountId: params.accountId });
  const entries = Object.values(state.users)
    .filter((entry) => matchesUserQuery(entry, params.query || ""))
    .toSorted((a, b) => b.lastSeenAt - a.lastSeenAt);
  if (params.limit && params.limit > 0) {
    return entries.slice(0, params.limit);
  }
  return entries;
}

/**
 * Reverse-lookup a user's staffId (or canonicalUserId fallback) from a conversationId.
 *
 * Returns the resolved id only when **exactly one** known user has been observed
 * in this conversation, which is the safe signal for a 1:1 (single-chat) target.
 * For real groups, multiple users will be present and we return null to preserve
 * group-routing behavior at call sites.
 *
 * Used by send-target resolution to recover from the case where a single-chat
 * conversationId (e.g. `cidt...`) is passed as the send target: the directory
 * lets us route via oToMessages/batchSend with the correct userId instead of
 * mis-routing to groupMessages/send (which fails with "robot 不存在" because the
 * enterprise app's AppKey is not registered as a per-group robot).
 */
export function findUserStaffIdByConversationId(params: {
  storePath?: string;
  accountId: string;
  conversationId: string;
}): string | null {
  const conversationId = trimValue(params.conversationId);
  if (!conversationId) {
    return null;
  }
  const targetNorm = normalizeLookup(conversationId);
  const state = readState({ storePath: params.storePath, accountId: params.accountId });
  // If this conversation is already known as a group (the plugin has previously
  // observed it as one via inbound group messages), never demote it to a single
  // user even if only one user has been seen there yet (e.g. brand-new groups
  // where only one member has spoken). Group identity is a hard signal that
  // overrides the user-side reverse-lookup.
  if (state.groups[conversationId]) {
    return null;
  }
  const matches: UserTargetEntry[] = [];
  for (const user of Object.values(state.users)) {
    const seen = user.lastSeenInConversationIds || [];
    if (seen.some((cid) => normalizeLookup(cid) === targetNorm)) {
      matches.push(user);
      if (matches.length > 1) {
        return null;
      }
    }
  }
  if (matches.length !== 1) {
    return null;
  }
  const only = matches[0];
  return only.staffId || only.canonicalUserId || null;
}
