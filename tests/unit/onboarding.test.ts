import { readFileSync } from "node:fs";
import type { OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk/setup";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/setup", () => ({
    DEFAULT_ACCOUNT_ID: "default",
    normalizeAccountId: (value: string) => value.trim() || "default",
    formatDocsLink: (path: string) => `https://docs.example${path}`,
}));

const mockBeginDeviceRegistration = vi.fn();

vi.mock("../../src/device-registration", () => ({
  beginDeviceRegistration: (...args: unknown[]) => mockBeginDeviceRegistration(...args),
  RegistrationError: class RegistrationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "RegistrationError";
    }
  },
}));

import { dingtalkSetupAdapter, dingtalkSetupWizard } from "../../src/onboarding";

function listAccountIds(cfg: OpenClawConfig): string[] {
    const dingtalk = cfg.channels?.dingtalk as { accounts?: Record<string, unknown> } | undefined;
    return Object.keys(dingtalk?.accounts ?? {});
}

async function runSetupWizardConfigure(params: {
    cfg?: OpenClawConfig;
    prompter: WizardPrompter;
    shouldPromptAccountIds?: boolean;
}): Promise<{ cfg: OpenClawConfig; accountId: string }> {
    const cfg = (params.cfg ?? {}) as OpenClawConfig;
    const accountId =
        (await dingtalkSetupWizard.resolveAccountIdForConfigure?.({
            cfg,
            prompter: params.prompter,
            shouldPromptAccountIds: params.shouldPromptAccountIds ?? false,
            listAccountIds,
            defaultAccountId: "default",
        })) ?? "default";

    const finalized = await dingtalkSetupWizard.finalize?.({
        cfg,
        accountId,
        prompter: params.prompter,
    });

    return {
        cfg: finalized?.cfg ?? cfg,
        accountId,
    };
}

describe("dingtalk setup wizard", () => {
    beforeEach(() => {
        mockBeginDeviceRegistration.mockReset();
    });

    it("status returns configured=false for empty config", async () => {
        const configured = await dingtalkSetupWizard.status.resolveConfigured({ cfg: {} as any });

        expect(configured).toBe(false);
    });

    it("status treats a valid env SecretInput reference as configured without resolving it", async () => {
        delete process.env.DINGTALK_MISSING_SETUP_SECRET;

        const configured = await dingtalkSetupWizard.status.resolveConfigured({
            cfg: {
                channels: {
                    dingtalk: {
                        clientId: "ding_client",
                        clientSecret: {
                            source: "env",
                            provider: "env",
                            id: "DINGTALK_MISSING_SETUP_SECRET",
                        },
                    },
                },
            } as any,
        });

        expect(configured).toBe(true);
    });

    it("allows adding a named account during setup", async () => {
        const confirm = vi.fn();
        const select = vi.fn().mockResolvedValueOnce("new");
        const text = vi.fn().mockResolvedValueOnce("work");

        const accountId = await dingtalkSetupWizard.resolveAccountIdForConfigure?.({
            cfg: {
                channels: {
                    dingtalk: {
                        clientId: "default-id",
                        clientSecret: "default-secret",
                        accounts: {
                            test: { clientId: "test-id", clientSecret: "test-secret" },
                        },
                    },
                },
            } as any,
            prompter: { confirm, select, text } as unknown as WizardPrompter,
            shouldPromptAccountIds: true,
            listAccountIds: () => ["default", "test"],
            defaultAccountId: "default",
        });

        expect(accountId).toBe("work");
        expect(select).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining("DingTalk account"),
            }),
        );
    });

    it("forces account target selection for DingTalk onboarding surfaces", () => {
        const shouldPrompt = dingtalkSetupWizard.resolveShouldPromptAccountIds?.({
            cfg: {} as any,
            shouldPromptAccountIds: false,
        });

        expect(shouldPrompt).toBe(true);
    });

    it("keeps DingTalk onboarding prompts in English", () => {
        const onboardingSource = readFileSync("src/onboarding.ts", "utf8");

        expect(onboardingSource).not.toMatch(/\p{Script=Han}/u);
    });

    it("allows modifying an existing named account during setup", async () => {
        const select = vi.fn().mockResolvedValueOnce("existing").mockResolvedValueOnce("test");
        const text = vi.fn();

        const accountId = await dingtalkSetupWizard.resolveAccountIdForConfigure?.({
            cfg: {
                channels: {
                    dingtalk: {
                        accounts: {
                            test: { clientId: "test-id", clientSecret: "test-secret" },
                        },
                    },
                },
            } as any,
            prompter: { select, text } as unknown as WizardPrompter,
            shouldPromptAccountIds: true,
            listAccountIds: () => ["test"],
            defaultAccountId: "default",
        });

        expect(accountId).toBe("test");
        expect(text).not.toHaveBeenCalled();
    });

    it("configure writes credentials and basic policies without allowlist prompts", async () => {
        const note = vi.fn();
        const text = vi
            .fn()
            .mockResolvedValueOnce("ding_client")
            .mockResolvedValueOnce("ding_secret");

        const confirm = vi.fn().mockResolvedValueOnce(false);

        const select = vi
            .fn()
            .mockResolvedValueOnce("manual")
            .mockResolvedValueOnce("allowlist")
            .mockResolvedValueOnce("allowlist")
            .mockResolvedValueOnce("markdown");

        const result = await runSetupWizardConfigure({
            cfg: {} as any,
            prompter: { note, text, confirm, select } as unknown as WizardPrompter,
        });

        const dingtalkConfig = result.cfg.channels?.dingtalk;
        expect(dingtalkConfig).toBeTruthy();
        if (!dingtalkConfig) {
            throw new Error("Expected dingtalk config to be present");
        }

        expect(result.accountId).toBe("default");
        expect(dingtalkConfig.clientId).toBe("ding_client");
        expect(dingtalkConfig.clientSecret).toBe("ding_secret");
        expect((dingtalkConfig as any).corpId).toBeUndefined();
        expect((dingtalkConfig as any).agentId).toBeUndefined();
        expect(dingtalkConfig.dmPolicy).toBe("allowlist");
        expect(dingtalkConfig.groupPolicy).toBe("allowlist");
        expect(dingtalkConfig.messageType).toBe("markdown");
        expect(dingtalkConfig.cardStreamingMode).toBeUndefined();
        expect(dingtalkConfig.cardTemplateId).toBeUndefined();
        expect(dingtalkConfig.cardTemplateKey).toBeUndefined();
        expect(dingtalkConfig.allowFrom).toBeUndefined();
        expect(dingtalkConfig.groupAllowFrom).toBeUndefined();
        expect(dingtalkConfig.displayNameResolution).toBeUndefined();
        expect(dingtalkConfig.mediaUrlAllowlist).toBeUndefined();
        expect(dingtalkConfig.maxReconnectCycles).toBeUndefined();
        expect(dingtalkConfig.mediaMaxMb).toBeUndefined();
        expect(dingtalkConfig.journalTTLDays).toBeUndefined();
        expect(text).toHaveBeenCalledTimes(2);
        expect(note).toHaveBeenCalledWith(
            expect.stringContaining("userId"),
            expect.any(String),
        );
        expect(note).toHaveBeenCalledWith(
            expect.stringContaining("conversationId"),
            expect.any(String),
        );
    });

    it("generic setup input stores clientId and clientSecret without legacy fields", () => {
        const cfg = dingtalkSetupAdapter.applyAccountConfig({
            cfg: {} as any,
            accountId: "default",
            input: {
                token: "ding_client",
                password: "ding_secret",
                code: "ding_robot",
            } as any,
        });

        const dingtalkConfig = cfg.channels?.dingtalk;
        expect(dingtalkConfig?.clientId).toBe("ding_client");
        expect(dingtalkConfig?.clientSecret).toBe("ding_secret");
    });

    it("preserves existing SecretInput when manual setup saves unchanged credentials", async () => {
        process.env.DINGTALK_EXISTING_SECRET = "secret-from-env";
        const note = vi.fn();
        const text = vi.fn(async (options: { initialValue?: string }) => options.initialValue);
        const confirm = vi.fn().mockResolvedValueOnce(false);
        const select = vi
            .fn()
            .mockResolvedValueOnce("manual")
            .mockResolvedValueOnce("open")
            .mockResolvedValueOnce("open")
            .mockResolvedValueOnce("markdown");

        const result = await runSetupWizardConfigure({
            cfg: {
                channels: {
                    dingtalk: {
                        clientId: "ding_client",
                        clientSecret: {
                            source: "env",
                            provider: "env",
                            id: "DINGTALK_EXISTING_SECRET",
                        },
                    },
                },
            } as any,
            prompter: { note, text, confirm, select } as unknown as WizardPrompter,
        });

        const dingtalkConfig = result.cfg.channels?.dingtalk;
        expect(dingtalkConfig?.clientId).toBe("ding_client");
        expect(dingtalkConfig?.clientSecret).toEqual({
            source: "env",
            provider: "env",
            id: "DINGTALK_EXISTING_SECRET",
        });
        expect(text).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                initialValue: "<env:env:DINGTALK_EXISTING_SECRET>",
            }),
        );
    });

    it("configure with disabled groupPolicy skips groupAllowFrom prompt", async () => {
        const note = vi.fn();
        const text = vi
            .fn()
            .mockResolvedValueOnce("ding_client")
            .mockResolvedValueOnce("ding_secret");

        const confirm = vi.fn().mockResolvedValueOnce(false);

        const select = vi
            .fn()
            .mockResolvedValueOnce("manual")
            .mockResolvedValueOnce("open")
            .mockResolvedValueOnce("disabled")
            .mockResolvedValueOnce("markdown");

        const result = await runSetupWizardConfigure({
            cfg: {} as any,
            prompter: { note, text, confirm, select } as unknown as WizardPrompter,
        });

        const dingtalkConfig = result.cfg.channels?.dingtalk;
        expect(dingtalkConfig).toBeTruthy();
        if (!dingtalkConfig) {
            throw new Error("Expected dingtalk config to be present");
        }

        expect(dingtalkConfig.groupPolicy).toBe("disabled");
        expect(dingtalkConfig.groupAllowFrom).toBeUndefined();
        expect(text).toHaveBeenCalledTimes(2);
    });

    it("auto-register branch writes credentials to config", async () => {
        mockBeginDeviceRegistration.mockResolvedValueOnce({
            verificationUrl: "https://oapi.dingtalk.com/verify?code=test",
            waitForResult: vi.fn().mockResolvedValueOnce({
                clientId: "ding-auto-id",
                clientSecret: "ding-auto-secret-12345",
            }),
        });

        const note = vi.fn();
        const text = vi.fn();

        const confirm = vi.fn().mockResolvedValueOnce(false);

        const select = vi
            .fn()
            .mockResolvedValueOnce("auto")
            .mockResolvedValueOnce("open")
            .mockResolvedValueOnce("open")
            .mockResolvedValueOnce("markdown");

        const result = await runSetupWizardConfigure({
            cfg: {} as any,
            prompter: { note, text, confirm, select } as unknown as WizardPrompter,
        });

        const dingtalkConfig = result.cfg.channels?.dingtalk;
        expect(dingtalkConfig).toBeTruthy();
        if (!dingtalkConfig) throw new Error("Expected dingtalk config");

        expect(dingtalkConfig.clientId).toBe("ding-auto-id");
        expect(dingtalkConfig.clientSecret).toBe("ding-auto-secret-12345");
        expect(text).not.toHaveBeenCalled();
        expect(note).toHaveBeenCalledWith(
            expect.stringContaining("https://oapi.dingtalk.com/verify?code=test"),
            "DingTalk bot auto-registration",
        );
    });

    it("auto-register failure falls back to manual input", async () => {
        mockBeginDeviceRegistration.mockRejectedValueOnce(
            new (class extends Error {
              name = "RegistrationError";
              constructor() { super("network timeout"); }
            })(),
        );

        const note = vi.fn();
        const text = vi
            .fn()
            .mockResolvedValueOnce("ding-fallback-id")
            .mockResolvedValueOnce("ding-fallback-secret");

        const confirm = vi.fn().mockResolvedValueOnce(false);

        const select = vi
            .fn()
            .mockResolvedValueOnce("auto")
            .mockResolvedValueOnce("open")
            .mockResolvedValueOnce("open")
            .mockResolvedValueOnce("markdown");

        const result = await runSetupWizardConfigure({
            cfg: {} as any,
            prompter: { note, text, confirm, select } as unknown as WizardPrompter,
        });

        const dingtalkConfig = result.cfg.channels?.dingtalk;
        expect(dingtalkConfig).toBeTruthy();
        if (!dingtalkConfig) throw new Error("Expected dingtalk config");

        expect(dingtalkConfig.clientId).toBe("ding-fallback-id");
        expect(dingtalkConfig.clientSecret).toBe("ding-fallback-secret");
        expect(note).toHaveBeenCalledWith(expect.stringContaining("network timeout"), expect.any(String));
    });

    it("skips card advanced settings by default", async () => {
        const note = vi.fn();
        const text = vi
            .fn()
            .mockResolvedValueOnce("ding-id")
            .mockResolvedValueOnce("ding-secret");
        const confirm = vi.fn().mockResolvedValueOnce(false);
        const select = vi
            .fn()
            .mockResolvedValueOnce("manual")
            .mockResolvedValueOnce("open")
            .mockResolvedValueOnce("open")
            .mockResolvedValueOnce("card");

        const result = await runSetupWizardConfigure({
            cfg: {} as any,
            prompter: { note, text, confirm, select } as unknown as WizardPrompter,
        });

        const dingtalkConfig = result.cfg.channels?.dingtalk as any;
        expect(dingtalkConfig.messageType).toBe("card");
        expect(dingtalkConfig.cardStreamingMode).toBeUndefined();
        expect(dingtalkConfig.cardStreamInterval).toBeUndefined();
        expect(dingtalkConfig.cardAtSender).toBeUndefined();
        expect(dingtalkConfig.cardStatusLine).toBeUndefined();
    });

    it("writes card advanced settings when card mode advanced setup is enabled", async () => {
        const note = vi.fn();
        const text = vi
            .fn()
            .mockResolvedValueOnce("ding-id")
            .mockResolvedValueOnce("ding-secret")
            .mockResolvedValueOnce("750")
            .mockResolvedValueOnce("Reply complete");
        const confirm = vi
            .fn()
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(false);
        const select = vi
            .fn()
            .mockResolvedValueOnce("manual")
            .mockResolvedValueOnce("open")
            .mockResolvedValueOnce("open")
            .mockResolvedValueOnce("card")
            .mockResolvedValueOnce("answer");

        const result = await runSetupWizardConfigure({
            cfg: {} as any,
            prompter: { note, text, confirm, select } as unknown as WizardPrompter,
        });

        const dingtalkConfig = result.cfg.channels?.dingtalk as any;
        expect(dingtalkConfig.cardStreamingMode).toBe("answer");
        expect(dingtalkConfig.cardStreamInterval).toBe(750);
        expect(dingtalkConfig.cardAtSender).toBe("Reply complete");
        expect(dingtalkConfig.cardStatusLine).toEqual({
            model: true,
            effort: false,
            agent: true,
            taskTime: false,
            tokens: false,
            dapiUsage: false,
        });
    });

    it("writes a newly configured named account without overwriting default account", async () => {
        const note = vi.fn();
        const text = vi
            .fn()
            .mockResolvedValueOnce("ding-work-id")
            .mockResolvedValueOnce("ding-work-secret");
        const confirm = vi.fn().mockResolvedValueOnce(false);
        const select = vi
            .fn()
            .mockResolvedValueOnce("manual")
            .mockResolvedValueOnce("open")
            .mockResolvedValueOnce("disabled")
            .mockResolvedValueOnce("markdown");

        const finalized = await dingtalkSetupWizard.finalize?.({
            cfg: {
                channels: {
                    dingtalk: {
                        clientId: "default-id",
                        clientSecret: "default-secret",
                    },
                },
            } as any,
            accountId: "work",
            prompter: { note, text, confirm, select } as unknown as WizardPrompter,
        });

        const dingtalk = finalized?.cfg.channels?.dingtalk as any;
        expect(dingtalk.clientId).toBe("default-id");
        expect(dingtalk.clientSecret).toBe("default-secret");
        expect(dingtalk.accounts.work.clientId).toBe("ding-work-id");
        expect(dingtalk.accounts.work.clientSecret).toBe("ding-work-secret");
        expect(dingtalk.accounts.work.groupPolicy).toBe("disabled");
    });

    it("shows final guidance for named accounts and gateway restart", async () => {
        const note = vi.fn();
        const text = vi
            .fn()
            .mockResolvedValueOnce("ding-id")
            .mockResolvedValueOnce("ding-secret");
        const confirm = vi.fn().mockResolvedValueOnce(false);
        const select = vi
            .fn()
            .mockResolvedValueOnce("manual")
            .mockResolvedValueOnce("open")
            .mockResolvedValueOnce("open")
            .mockResolvedValueOnce("markdown");

        await runSetupWizardConfigure({
            cfg: {} as any,
            prompter: { note, text, confirm, select } as unknown as WizardPrompter,
        });

        expect(note).toHaveBeenCalledWith(
            expect.stringContaining("channels.dingtalk.accounts"),
            "DingTalk setup complete",
        );
        expect(note).toHaveBeenCalledWith(
            expect.stringContaining("openclaw gateway restart"),
            "DingTalk setup complete",
        );
    });

    it("manual branch works unchanged", async () => {
        const note = vi.fn();
        const text = vi
            .fn()
            .mockResolvedValueOnce("ding-manual-id")
            .mockResolvedValueOnce("ding-manual-secret");

        const confirm = vi.fn().mockResolvedValueOnce(false);

        const select = vi
            .fn()
            .mockResolvedValueOnce("manual")
            .mockResolvedValueOnce("open")
            .mockResolvedValueOnce("open")
            .mockResolvedValueOnce("markdown");

        const result = await runSetupWizardConfigure({
            cfg: {} as any,
            prompter: { note, text, confirm, select } as unknown as WizardPrompter,
        });

        const dingtalkConfig = result.cfg.channels?.dingtalk;
        expect(dingtalkConfig).toBeTruthy();
        if (!dingtalkConfig) throw new Error("Expected dingtalk config");

        expect(dingtalkConfig.clientId).toBe("ding-manual-id");
        expect(dingtalkConfig.clientSecret).toBe("ding-manual-secret");
        expect(mockBeginDeviceRegistration).not.toHaveBeenCalled();
    });
});
