import { describe, it, expect, vi } from "vitest";
import {
    isReplySessionConflictError,
    withReplySessionConflictRetry,
} from "../../src/gateway/reply-session-conflict";

describe("isReplySessionConflictError", () => {
    it("matches the core reply-session conflict message", () => {
        expect(
            isReplySessionConflictError(
                new Error("reply session initialization conflicted for agent:main:dingtalk:direct:test-user-1"),
            ),
        ).toBe(true);
    });

    it("is case-insensitive", () => {
        expect(
            isReplySessionConflictError(
                new Error("Reply Session Initialization Conflicted for x"),
            ),
        ).toBe(true);
    });

    it("rejects unrelated errors", () => {
        expect(isReplySessionConflictError(new Error("network timeout"))).toBe(false);
        expect(isReplySessionConflictError(undefined)).toBe(false);
        expect(isReplySessionConflictError("some string")).toBe(false);
    });

    it("accepts non-Error throwables by stringifying them", () => {
        expect(isReplySessionConflictError("reply session initialization conflicted")).toBe(true);
    });
});

describe("withReplySessionConflictRetry", () => {
    it("returns the result when fn succeeds on the first try", async () => {
        const fn = vi.fn().mockResolvedValue("ok");
        const result = await withReplySessionConflictRetry(fn, { maxRetries: 3, baseDelayMs: 1 });
        expect(result).toBe("ok");
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries on reply-session conflict and eventually succeeds", async () => {
        const fn = vi
            .fn()
            .mockRejectedValueOnce(new Error("reply session initialization conflicted for s1"))
            .mockRejectedValueOnce(new Error("reply session initialization conflicted for s1"))
            .mockResolvedValueOnce("recovered");
        const log = { warn: vi.fn(), info: vi.fn() };
        const result = await withReplySessionConflictRetry(fn, {
            maxRetries: 3,
            baseDelayMs: 1,
            log,
            sessionKey: "s1",
        });
        expect(result).toBe("recovered");
        expect(fn).toHaveBeenCalledTimes(3);
        expect(log.warn).toHaveBeenCalled();
    });

    it("rethrows a conflict error once maxRetries is exhausted", async () => {
        const conflictErr = new Error("reply session initialization conflicted for s1");
        const fn = vi.fn().mockRejectedValue(conflictErr);
        await expect(
            withReplySessionConflictRetry(fn, { maxRetries: 2, baseDelayMs: 1 }),
        ).rejects.toBe(conflictErr);
        // 1 initial attempt + 2 retries
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it("does NOT retry unrelated errors — rethrows immediately", async () => {
        const timeoutErr = new Error("network timeout");
        const fn = vi.fn().mockRejectedValue(timeoutErr);
        await expect(
            withReplySessionConflictRetry(fn, { maxRetries: 5, baseDelayMs: 1 }),
        ).rejects.toBe(timeoutErr);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("respects maxRetries=0 (no retries, single attempt)", async () => {
        const conflictErr = new Error("reply session initialization conflicted for s1");
        const fn = vi.fn().mockRejectedValue(conflictErr);
        await expect(
            withReplySessionConflictRetry(fn, { maxRetries: 0, baseDelayMs: 1 }),
        ).rejects.toBe(conflictErr);
        expect(fn).toHaveBeenCalledTimes(1);
    });
});
