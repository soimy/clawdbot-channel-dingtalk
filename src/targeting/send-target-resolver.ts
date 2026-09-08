import { stripTargetPrefix } from "../config";
import { resolveOriginalPeerId } from "../peer-id-registry";
import { findUserStaffIdByConversationId } from "./target-directory-store";

export interface ResolvedDingTalkSendTarget {
  /** Target after `stripTargetPrefix` + case-sensitive peer-id restore. */
  resolvedTarget: string;
  /** Whether the send should use the group API (`groupMessages/send`). */
  isGroup: boolean;
  /**
   * When `isGroup` is `false` and a single-chat conversationId was reverse-looked-up
   * to a known user, this holds the resolved staffId to use in the `userIds` payload.
   * Otherwise `null`; callers should fall back to `resolvedTarget` for `userIds`.
   */
  resolvedUserStaffId: string | null;
}

/**
 * Resolve a target string into a routing decision + final user staffId for proactive send.
 *
 * Background — DingTalk single-chat conversationIds (e.g. `cidt...` prefix) are easy to
 * mistake for group conversationIds because both start with `cid`. Sending a single-chat
 * conversationId via `groupMessages/send` returns `resource.not.found / robot 不存在`
 * because the enterprise app's AppKey is not registered as a per-group robot. Sending the
 * same conversationId via `oToMessages/batchSend` also fails (`staffId.notExisted`) because
 * a conversationId is not a valid `userIds` value.
 *
 * Fix — when the target is `cid`-prefixed but the directory store has **exactly one**
 * known user whose `lastSeenInConversationIds` includes this conversationId, route via
 * `oToMessages/batchSend` with that user's staffId. This restores single-chat proactive
 * delivery without affecting genuine group routing (groups have multiple known users in
 * `lastSeenInConversationIds`, so the lookup returns null and falls back to group route).
 *
 * Compatibility — explicit `user:` / `group:` prefixes still take precedence (handled by
 * `stripTargetPrefix`). Plain numeric staffIds remain user-routed. Unknown `cid*` targets
 * with no directory match keep the original group routing, so this change is backwards
 * compatible for any caller previously relying on that behavior.
 */
export function resolveDingTalkSendTarget(params: {
  target: string;
  storePath?: string;
  accountId?: string;
}): ResolvedDingTalkSendTarget {
  const { targetId, isExplicitUser } = stripTargetPrefix(params.target);
  const resolvedTarget = resolveOriginalPeerId(targetId);
  const looksLikeCid = !isExplicitUser && resolvedTarget.startsWith("cid");
  if (!looksLikeCid) {
    return { resolvedTarget, isGroup: false, resolvedUserStaffId: null };
  }
  if (params.accountId) {
    const staffId = findUserStaffIdByConversationId({
      storePath: params.storePath,
      accountId: params.accountId,
      conversationId: resolvedTarget,
    });
    if (staffId) {
      return { resolvedTarget, isGroup: false, resolvedUserStaffId: staffId };
    }
  }
  return { resolvedTarget, isGroup: true, resolvedUserStaffId: null };
}
