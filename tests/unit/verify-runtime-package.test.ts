import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = resolve("scripts/verify-runtime-package.mjs");

describe("runtime package verification", () => {
    let tempDir: string | undefined;

    afterEach(() => {
        if (tempDir) {
            rmSync(tempDir, { recursive: true, force: true });
            tempDir = undefined;
        }
    });

    it("allows RegExp exec method calls in runtime output", () => {
        const packageDir = createRuntimePackageFixture(`
const match = /token-(\\d+)/u.exec("token-42");
export { match };
`);

        expect(() => {
            execFileSync(process.execPath, [scriptPath], {
                cwd: packageDir,
                encoding: "utf8",
                env: {
                    ...process.env,
                    npm_config_cache: join(packageDir, ".npm-cache"),
                },
                stdio: ["ignore", "pipe", "pipe"],
            });
        }).not.toThrow();
    });

    it("rejects standalone process execution calls in runtime output", () => {
        const packageDir = createRuntimePackageFixture(`
exec("open https://example.com");
`);

        expect(() => {
            execFileSync(process.execPath, [scriptPath], {
                cwd: packageDir,
                encoding: "utf8",
                env: {
                    ...process.env,
                    npm_config_cache: join(packageDir, ".npm-cache"),
                },
                stdio: ["ignore", "pipe", "pipe"],
            });
        }).toThrow("Runtime package must not include process execution calls");
    });

    it("rejects source maps in the published package", () => {
        const packageDir = createRuntimePackageFixture("export {};\n");
        writeFile(join(packageDir, "dist/index.js.map"), "{}\n");
        const packageJson = JSON.parse(
            readFileSync(join(packageDir, "package.json"), "utf8"),
        ) as { files: string[] };
        packageJson.files.push("dist/**/*.map");
        writeJson(join(packageDir, "package.json"), packageJson);

        expect(() => {
            execFileSync(process.execPath, [scriptPath], {
                cwd: packageDir,
                encoding: "utf8",
                env: {
                    ...process.env,
                    npm_config_cache: join(packageDir, ".npm-cache"),
                },
                stdio: ["ignore", "pipe", "pipe"],
            });
        }).toThrow("Runtime package must not include source maps");
    });

    function createRuntimePackageFixture(runtimeCode: string): string {
        tempDir = mkdtempSync(join(tmpdir(), "dingtalk-runtime-package-"));
        writeJson(join(tempDir, "package.json"), {
            name: "dingtalk-runtime-package-fixture",
            version: "0.0.0",
            type: "module",
            files: ["dist/**/*.js", "dist/**/*.d.ts", "openclaw.plugin.json"],
        });
        writeJson(join(tempDir, "openclaw.plugin.json"), {});
        writeFile(join(tempDir, "dist/index.js"), runtimeCode);
        writeFile(join(tempDir, "dist/index.d.ts"), "export {};\n");

        return tempDir;
    }

    function writeJson(filePath: string, value: unknown): void {
        writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
    }

    function writeFile(filePath: string, content: string): void {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, content);
    }
});
