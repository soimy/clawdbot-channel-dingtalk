import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function readInboundHandlerTestSource(): string {
  const filePath = fileURLToPath(new URL("./inbound-handler.test.ts", import.meta.url));
  return fs.readFileSync(filePath, "utf8");
}

function collectVitestTitles(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "inbound-handler.test.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const titles: string[] = [];

  const extractStaticTitle = (expression: ts.Expression | undefined): string | undefined => {
    if (!expression) {
      return undefined;
    }
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      return expression.text;
    }
    return undefined;
  };

  const isVitestTitleCall = (expression: ts.LeftHandSideExpression): boolean => {
    let current: ts.LeftHandSideExpression = expression;
    while (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
    }
    return ts.isIdentifier(current) && (current.text === "it" || current.text === "test");
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isVitestTitleCall(node.expression)) {
      const title = extractStaticTitle(node.arguments[0]);
      if (title !== undefined) {
        titles.push(title);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return titles;
}

function findDuplicateVitestTitles(source: string): string[] {
  const counts = new Map<string, number>();

  for (const title of collectVitestTitles(source)) {
    counts.set(title, (counts.get(title) || 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([title, count]) => `${count}x ${title}`);
}

describe("inbound-handler test structure", () => {
  it("keeps inbound queue modules in the gateway domain", () => {
    const srcRoot = fileURLToPath(new URL("../../src/", import.meta.url));

    expect(fs.existsSync(path.join(srcRoot, "inbound-session-queue.ts"))).toBe(false);
    expect(fs.existsSync(path.join(srcRoot, "inbound-session-queue-dispatcher.ts"))).toBe(false);
    expect(fs.existsSync(path.join(srcRoot, "reply-session-conflict.ts"))).toBe(false);
    expect(fs.existsSync(path.join(srcRoot, "gateway/inbound-session-queue.ts"))).toBe(true);
    expect(fs.existsSync(path.join(srcRoot, "gateway/inbound-session-queue-dispatcher.ts"))).toBe(true);
    expect(fs.existsSync(path.join(srcRoot, "gateway/reply-session-conflict.ts"))).toBe(true);
  });

  it("keeps inbound queue integration test files under 500 lines", () => {
    const integrationRoot = fileURLToPath(new URL("../integration/", import.meta.url));
    const queueTests = fs
      .readdirSync(integrationRoot)
      .filter((name) => name.startsWith("inbound-session-queue") && name.endsWith(".test.ts"));

    expect(queueTests.length).toBeGreaterThan(1);
    for (const testFile of queueTests) {
      const lineCount = fs.readFileSync(path.join(integrationRoot, testFile), "utf8").split("\n").length;
      expect(lineCount, testFile).toBeLessThanOrEqual(500);
    }
  });

  it("does not contain duplicate test titles", () => {
    expect(findDuplicateVitestTitles(readInboundHandlerTestSource())).toEqual([]);
  });

  it("resolves the target test file independently from process.cwd", () => {
    const originalCwd = process.cwd();

    try {
      process.chdir(path.resolve(originalCwd, ".."));

      expect(readInboundHandlerTestSource()).toContain('describe("inbound-handler"');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("collects static Vitest titles without matching comments", () => {
    const source = `
      it("plain title", () => {});
      it.only("only title", () => {});
      test.skip("skip title", () => {});
      it(\`template title\`, () => {});
      // it("comment title", () => {});
    `;

    expect(collectVitestTitles(source)).toEqual([
      "plain title",
      "only title",
      "skip title",
      "template title",
    ]);
  });
});
