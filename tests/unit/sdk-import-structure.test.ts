import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");

const directSdkFiles = [
    "index.ts",
    "src/channel.ts",
    "src/config.ts",
    "src/card/card-action-handler.ts",
    "src/card/card-stop-handler.ts",
    "src/command/card-stop-command.ts",
    "src/onboarding.ts",
    "src/runtime.ts",
    "src/types.ts",
    "src/targeting/agent-name-matcher.ts",
    "src/targeting/agent-routing.ts",
    "src/targeting/target-directory-adapter.ts",
];

const scopedSdkTestFiles = [
    "tests/integration/channel-config-status.test.ts",
    "tests/integration/gateway-inbound-flow.test.ts",
    "tests/integration/gateway-start-flow.test.ts",
    "tests/integration/send-lifecycle.test.ts",
    "tests/integration/send-media-flow.test.ts",
    "tests/integration/status-probe.test.ts",
    "tests/unit/agent-name-matcher.test.ts",
];

describe("plugin-sdk import structure", () => {
    it("does not keep the local sdk-compat bridge once minimum openclaw is 2026.3.14+", () => {
        expect(existsSync(resolve(repoRoot, "src/sdk-compat.ts"))).toBe(false);
    });

    it("uses direct plugin-sdk imports instead of the local sdk-compat bridge", () => {
        for (const relativePath of directSdkFiles) {
            const content = readFileSync(resolve(repoRoot, relativePath), "utf8");
            expect(content).not.toMatch(/from\s+["'](?:\.\.\/|\.\/)*sdk-compat["']/);
        }
    });

    it("keeps production code on scoped plugin-sdk subpaths instead of the root barrel", () => {
        for (const relativePath of directSdkFiles) {
            const content = readFileSync(resolve(repoRoot, relativePath), "utf8");
            expect(content).not.toMatch(/from\s+["']openclaw\/plugin-sdk["']/);
        }
    });

    it("does not depend on the removed telegram-core sdk subpath in production code", () => {
        for (const relativePath of directSdkFiles) {
            const content = readFileSync(resolve(repoRoot, relativePath), "utf8");
            expect(content).not.toMatch(/from\s+["']openclaw\/plugin-sdk\/telegram-core["']/);
        }
    });

    it("keeps tests on scoped plugin-sdk subpaths instead of the root barrel", () => {
        for (const relativePath of scopedSdkTestFiles) {
            const content = readFileSync(resolve(repoRoot, relativePath), "utf8");
            expect(content).not.toMatch(/from\s+["']openclaw\/plugin-sdk["']/);
        }
    });

    it("does not keep a tsconfig path alias for the deprecated plugin-sdk root barrel", () => {
        const tsconfig = JSON.parse(readFileSync(resolve(repoRoot, "tsconfig.json"), "utf8")) as {
            compilerOptions?: {
                paths?: Record<string, string[]>;
            };
        };
        expect(tsconfig.compilerOptions?.paths?.["openclaw/plugin-sdk"]).toBeUndefined();
    });

    it("does not keep the temporary local stop-command shim once command-auth exports it", () => {
        const content = readFileSync(resolve(repoRoot, "src/command/card-stop-command.ts"), "utf8");
        expect(content).not.toMatch(/Inlined because the CI openclaw package does not yet export that sub-path/);
        expect(content).not.toMatch(/function\s+resolveNativeCommandSessionTargets\s*\(/);
    });

    it("pins the build SDK while keeping runtime host compatibility explicit", () => {
        const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
            devDependencies?: Record<string, string>;
            peerDependencies?: Record<string, string>;
            openclaw?: {
                install?: {
                    minHostVersion?: string;
                };
            };
        };
        expect(packageJson.devDependencies?.openclaw).toBe("2026.7.1-2");
        expect(packageJson.peerDependencies?.openclaw).toBeDefined();
        expect(packageJson.peerDependencies?.openclaw).toBe(">=2026.7.1-2");
        expect(packageJson.openclaw?.install?.minHostVersion).toBe(">=2026.7.1-2");
    });
});
