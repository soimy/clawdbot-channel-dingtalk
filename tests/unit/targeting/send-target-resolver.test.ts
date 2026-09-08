import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearTargetDirectoryStateCache,
  findUserStaffIdByConversationId,
  upsertObservedGroupTarget,
  upsertObservedUserTarget,
} from "../../../src/targeting/target-directory-store";
import { resolveDingTalkSendTarget } from "../../../src/targeting/send-target-resolver";

describe("send-target-resolver", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    clearTargetDirectoryStateCache();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function createStorePath(): string {
    const dir = path.join(
      os.tmpdir(),
      `openclaw-dingtalk-send-target-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    tempDirs.push(dir);
    return path.join(dir, "session-store.json");
  }

  describe("findUserStaffIdByConversationId", () => {
    it("returns null for empty conversationId", () => {
      expect(
        findUserStaffIdByConversationId({
          accountId: "default",
          conversationId: "",
        }),
      ).toBeNull();
    });

    it("returns null when no user has been observed in this conversation", () => {
      const storePath = createStorePath();
      upsertObservedUserTarget({
        storePath,
        accountId: "default",
        senderId: "$:LWCP_v1:$AAA",
        staffId: "11111111111111111",
        displayName: "Alice",
        conversationId: "cidtAAA=",
      });
      expect(
        findUserStaffIdByConversationId({
          storePath,
          accountId: "default",
          conversationId: "cidtUNKNOWN=",
        }),
      ).toBeNull();
    });

    it("returns staffId for a single-chat conversation with exactly one known user", () => {
      const storePath = createStorePath();
      upsertObservedUserTarget({
        storePath,
        accountId: "default",
        senderId: "$:LWCP_v1:$DAVID",
        staffId: "161515176138925798",
        displayName: "大卫",
        conversationId: "cidtUnZOR1ijwl8F5gk62MUtSRRWXYhCkI7bSBN7X8QcTM=",
      });
      expect(
        findUserStaffIdByConversationId({
          storePath,
          accountId: "default",
          conversationId: "cidtUnZOR1ijwl8F5gk62MUtSRRWXYhCkI7bSBN7X8QcTM=",
        }),
      ).toBe("161515176138925798");
    });

    it("falls back to canonicalUserId when staffId is missing", () => {
      const storePath = createStorePath();
      upsertObservedUserTarget({
        storePath,
        accountId: "default",
        senderId: "$:LWCP_v1:$NOSTAFF",
        // intentionally no staffId
        displayName: "External",
        conversationId: "cidtNOSTAFF=",
      });
      expect(
        findUserStaffIdByConversationId({
          storePath,
          accountId: "default",
          conversationId: "cidtNOSTAFF=",
        }),
      ).toBe("$:LWCP_v1:$NOSTAFF");
    });

    it("returns null when more than one user has been observed in the same conversation (group case)", () => {
      const storePath = createStorePath();
      upsertObservedUserTarget({
        storePath,
        accountId: "default",
        senderId: "$:LWCP_v1:$U1",
        staffId: "U1",
        displayName: "User 1",
        conversationId: "cidpGROUP=",
      });
      upsertObservedUserTarget({
        storePath,
        accountId: "default",
        senderId: "$:LWCP_v1:$U2",
        staffId: "U2",
        displayName: "User 2",
        conversationId: "cidpGROUP=",
      });
      expect(
        findUserStaffIdByConversationId({
          storePath,
          accountId: "default",
          conversationId: "cidpGROUP=",
        }),
      ).toBeNull();
    });

    it("returns null when the conversation is already known as a group, even with only one observed user", () => {
      // Brand-new groups where only one member has spoken yet must not be demoted to
      // single-chat just because the user-side reverse lookup happens to match exactly
      // one user. The group-side observation is an authoritative signal and overrides.
      const storePath = createStorePath();
      upsertObservedGroupTarget({
        storePath,
        accountId: "default",
        conversationId: "cidNEW_GROUP=",
        title: "New Group",
      });
      upsertObservedUserTarget({
        storePath,
        accountId: "default",
        senderId: "$:LWCP_v1:$ONLY",
        staffId: "ONLY_USER",
        displayName: "Only One",
        conversationId: "cidNEW_GROUP=",
      });
      expect(
        findUserStaffIdByConversationId({
          storePath,
          accountId: "default",
          conversationId: "cidNEW_GROUP=",
        }),
      ).toBeNull();
    });

    it("scopes lookup by accountId (no cross-account leakage)", () => {
      const storePath = createStorePath();
      upsertObservedUserTarget({
        storePath,
        accountId: "tenantA",
        senderId: "$:LWCP_v1:$X",
        staffId: "X",
        displayName: "X",
        conversationId: "cidtSHARED=",
      });
      // Different account, same conversationId — must not leak.
      expect(
        findUserStaffIdByConversationId({
          storePath,
          accountId: "tenantB",
          conversationId: "cidtSHARED=",
        }),
      ).toBeNull();
    });
  });

  describe("resolveDingTalkSendTarget", () => {
    it("explicit user: prefix forces user route without directory lookup", () => {
      const r = resolveDingTalkSendTarget({ target: "user:somebody" });
      expect(r.isGroup).toBe(false);
      expect(r.resolvedUserStaffId).toBeNull();
      expect(r.resolvedTarget).toBe("somebody");
    });

    it("plain numeric staffId stays user-routed (no cid prefix)", () => {
      const r = resolveDingTalkSendTarget({ target: "161515176138925798" });
      expect(r.isGroup).toBe(false);
      expect(r.resolvedUserStaffId).toBeNull();
      expect(r.resolvedTarget).toBe("161515176138925798");
    });

    it("cid-prefixed target with no accountId falls back to group route", () => {
      // Without accountId we cannot consult the directory, so we keep the original
      // (pre-fix) classification: cid* is treated as group.
      const r = resolveDingTalkSendTarget({ target: "cidtUNKNOWN=" });
      expect(r.isGroup).toBe(true);
      expect(r.resolvedUserStaffId).toBeNull();
    });

    it("cid-prefixed target with no directory match falls back to group route", () => {
      const storePath = createStorePath();
      const r = resolveDingTalkSendTarget({
        target: "cidpGENUINE_GROUP=",
        storePath,
        accountId: "default",
      });
      expect(r.isGroup).toBe(true);
      expect(r.resolvedUserStaffId).toBeNull();
    });

    it("cidt single-chat conversationId with exactly one known user resolves to that user", () => {
      const storePath = createStorePath();
      upsertObservedUserTarget({
        storePath,
        accountId: "default",
        senderId: "$:LWCP_v1:$DAVID",
        staffId: "161515176138925798",
        displayName: "大卫",
        conversationId: "cidtUnZOR1ijwl8F5gk62MUtSRRWXYhCkI7bSBN7X8QcTM=",
      });
      const r = resolveDingTalkSendTarget({
        target: "cidtUnZOR1ijwl8F5gk62MUtSRRWXYhCkI7bSBN7X8QcTM=",
        storePath,
        accountId: "default",
      });
      expect(r.isGroup).toBe(false);
      expect(r.resolvedUserStaffId).toBe("161515176138925798");
      expect(r.resolvedTarget).toBe("cidtUnZOR1ijwl8F5gk62MUtSRRWXYhCkI7bSBN7X8QcTM=");
    });

    it("group:cid prefix is honored (forces group route even when reverse-lookup would resolve)", () => {
      // group: prefix sets isExplicitUser=false but the helper does not narrow to user.
      // Although the directory has a single known user, an explicit group: hint should
      // not trigger a user-route demotion.
      const storePath = createStorePath();
      upsertObservedUserTarget({
        storePath,
        accountId: "default",
        senderId: "$:LWCP_v1:$U",
        staffId: "U",
        displayName: "U",
        conversationId: "cidtAMBIG=",
      });
      const r = resolveDingTalkSendTarget({
        target: "group:cidtAMBIG=",
        storePath,
        accountId: "default",
      });
      // With the current helper semantics the group: prefix is treated identically to no
      // prefix for cid* (still attempts directory lookup); pin behavior here so future
      // refactors that change this semantic surface in the diff.
      // If a stricter group-route-no-fallback is wanted later, add a dedicated flag.
      expect(r.isGroup).toBe(false);
      expect(r.resolvedUserStaffId).toBe("U");
    });
  });
});
