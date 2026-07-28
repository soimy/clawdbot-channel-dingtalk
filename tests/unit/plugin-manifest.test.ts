import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");

function readJsonFile<T>(relativePath: string): T {
    return JSON.parse(readFileSync(resolve(repoRoot, relativePath), "utf8")) as T;
}

describe("plugin manifest channel metadata", () => {
    it("publishes DingTalk channel config metadata for the host WebUI", () => {
        const manifest = readJsonFile<{
            channelConfigs?: Record<
                string,
                {
                    label?: string;
                    description?: string;
                    schema?: {
                        type?: string;
                        properties?: Record<string, unknown>;
                    };
                    uiHints?: Record<string, { label?: string; sensitive?: boolean }>;
                }
            >;
        }>("openclaw.plugin.json");

        expect(manifest.channelConfigs?.dingtalk?.label).toBe("DingTalk");
        expect(manifest.channelConfigs?.dingtalk?.schema?.type).toBe("object");
        expect(manifest.channelConfigs?.dingtalk?.schema?.properties?.clientId).toBeDefined();
        expect(manifest.channelConfigs?.dingtalk?.schema?.properties?.accounts).toBeDefined();
        expect(manifest.channelConfigs?.dingtalk?.schema?.properties?.agentId).toBeDefined();
        expect(manifest.channelConfigs?.dingtalk?.schema?.properties?.corpId).toBeDefined();
        expect(manifest.channelConfigs?.dingtalk?.schema?.properties?.showThinkingStream).toBeDefined();
        expect(manifest.channelConfigs?.dingtalk?.schema?.properties?.asyncMode).toBeDefined();
        expect(manifest.channelConfigs?.dingtalk?.uiHints?.clientSecret?.sensitive).toBe(true);
        expect(manifest.channelConfigs?.dingtalk?.uiHints?.messageType?.label).toBeTruthy();
    });

    it("publishes contextVisibility in both top-level and account-level DingTalk schema", () => {
        const manifest = readJsonFile<{
            channelConfigs?: Record<
                string,
                {
                    schema?: {
                        properties?: Record<string, any>;
                    };
                }
            >;
        }>("openclaw.plugin.json");

        expect(
            manifest.channelConfigs?.dingtalk?.schema?.properties?.contextVisibility,
        ).toBeDefined();
        expect(
            manifest.channelConfigs?.dingtalk?.schema?.properties?.accounts?.additionalProperties
                ?.properties?.contextVisibility,
        ).toBeDefined();
    });

    it("publishes card streaming fields in both top-level and account-level DingTalk schema", () => {
        const manifest = readJsonFile<{
            channelConfigs?: Record<
                string,
                {
                    schema?: {
                        properties?: Record<string, any>;
                    };
                }
            >;
        }>("openclaw.plugin.json");

        const topLevelProperties = manifest.channelConfigs?.dingtalk?.schema?.properties;
        const accountLevelProperties = topLevelProperties?.accounts?.additionalProperties?.properties;

        expect(topLevelProperties?.cardStreamingMode).toEqual(expect.objectContaining({
            type: "string",
            enum: ["off", "answer", "all"],
        }));
        expect(topLevelProperties?.cardStreamInterval).toEqual(expect.objectContaining({
            type: "integer",
            minimum: 200,
            default: 1000,
        }));
        expect(accountLevelProperties?.cardStreamingMode).toEqual(expect.objectContaining({
            type: "string",
            enum: ["off", "answer", "all"],
        }));
        expect(accountLevelProperties?.cardStreamInterval).toEqual(expect.objectContaining({
            type: "integer",
            minimum: 200,
            default: 1000,
        }));
    });

    it("documents active and legacy DingTalk config fields for WebUI operators", () => {
        const manifest = readJsonFile<{
            channelConfigs?: Record<
                string,
                {
                    schema?: {
                        properties?: Record<string, any>;
                    };
                    uiHints?: Record<string, { help?: string }>;
                }
            >;
        }>("openclaw.plugin.json");

        const topLevelProperties = manifest.channelConfigs?.dingtalk?.schema?.properties;
        const accountLevelProperties = topLevelProperties?.accounts?.additionalProperties?.properties;

        expect(topLevelProperties?.cardStreamingMode?.description).toMatch(/stream|incremental|answer|reasoning/i);
        expect(topLevelProperties?.cardStreamInterval?.description).toMatch(/throttle|interval|millisecond|ms/i);
        expect(topLevelProperties?.cardRealTimeStream?.description).toMatch(/deprecated|compat/i);
        expect(topLevelProperties?.cardTemplateId?.description).toMatch(/deprecated|ignored|compat/i);
        expect(topLevelProperties?.showThinkingStream?.description).toMatch(/legacy|deprecated|compat|ignored/i);

        expect(accountLevelProperties?.cardStreamingMode?.description).toBe(
            topLevelProperties?.cardStreamingMode?.description,
        );
        expect(accountLevelProperties?.cardRealTimeStream?.description).toBe(
            topLevelProperties?.cardRealTimeStream?.description,
        );

        expect(manifest.channelConfigs?.dingtalk?.uiHints?.cardStreamingMode?.help).toMatch(
            /stream|answer|reasoning/i,
        );
        expect(manifest.channelConfigs?.dingtalk?.uiHints?.cardRealTimeStream?.help).toMatch(
            /deprecated|compat/i,
        );
    });

    it("keeps the OpenClaw compatibility metadata on the current SDK baseline", () => {
        const packageJson = readJsonFile<{
            peerDependencies?: Record<string, string>;
            openclaw?: {
                compat?: { pluginApi?: string };
                build?: { openclawVersion?: string };
                install?: { minHostVersion?: string };
            };
        }>("package.json");

        expect(packageJson.peerDependencies?.openclaw).toBe(">=2026.7.1-2");
        expect(packageJson.openclaw?.compat?.pluginApi).toBe(">=2026.7.1-2");
        expect(packageJson.openclaw?.build?.openclawVersion).toBe("2026.7.1-2");
        expect(packageJson.openclaw?.install?.minHostVersion).toBe(">=2026.7.1-2");
    });
});
