import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("axios", () => {
  const mockAxios = vi.fn();
  (mockAxios as any).put = vi.fn();
  return { default: mockAxios };
});

import { streamAICard } from "../../src/card-service";
import { resolveNamespacePath } from "../../src/persistence-store";
import { AICardStatus } from "../../src/types";

const mockedAxios = axios as any;
const testDirs: string[] = [];

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  mockedAxios.put.mockReset();
});

describe("card-service terminal stream recovery", () => {
  it("retains a terminal-only recovery record when final streaming fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-card-terminal-stream-"));
    testDirs.push(dir);
    const storePath = path.join(dir, "sessions.json");
    const statePath = resolveNamespacePath("cards.active.pending", {
      storePath,
      format: "json",
    });
    const card = {
      accountId: "main",
      cardInstanceId: "card_terminal_stream_failure",
      outTrackId: "track_terminal_stream_failure",
      conversationId: "cid_terminal_stream_failure",
      storePath,
      state: AICardStatus.INPUTING,
      createdAt: Date.now(),
      lastUpdated: Date.now(),
      accessToken: "token",
      config: {},
      lastStreamedContent: "已排队",
    } as any;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({ version: 1, updatedAt: Date.now(), pendingCards: [card] }),
    );
    mockedAxios.put.mockRejectedValueOnce(new Error("terminal stream failed"));

    await expect(streamAICard(card, "本次处理异常", true)).rejects.toThrow(
      "terminal stream failed",
    );

    expect(JSON.parse(fs.readFileSync(statePath, "utf8")).pendingCards).toMatchObject([
      {
        cardInstanceId: card.cardInstanceId,
        state: AICardStatus.FAILED,
        recoveryAction: "finalize",
      },
    ]);
  });
});
