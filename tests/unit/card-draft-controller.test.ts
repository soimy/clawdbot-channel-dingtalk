import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createCardDraftController } from "../../src/card-draft-controller";
import * as cardService from "../../src/card-service";
import { AICardStatus } from "../../src/types";
import type { AICardInstance, CardBlock } from "../../src/types";

vi.mock("../../src/card-service", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/card-service")>();
    return {
        ...actual,
        streamAICard: vi.fn(),
        updateAICardBlockList: vi.fn(),
        streamAICardContent: vi.fn(),
        clearAICardStreamingContent: vi.fn(),
    };
});

function makeCard(overrides: Partial<AICardInstance> = {}): AICardInstance {
    return {
        cardInstanceId: "card-1",
        accessToken: "token",
        conversationId: "conv-1",
        state: AICardStatus.PROCESSING,
        lastStreamedContent: "",
        createdAt: Date.now(),
        lastUpdated: Date.now(),
        ...overrides,
    } as AICardInstance;
}

function parseBlocks(content: string): CardBlock[] {
    try {
        return JSON.parse(content);
    } catch {
        return [];
    }
}

function getBlockText(blocks: CardBlock[], index: number): string {
    const block = blocks[index];
    if (!block) return "";
    return "markdown" in block ? block.markdown : "";
}

function getProcessBlockText(text: string): string {
    const lines = text.split("\n").filter((line) => line.trim());
    return lines
        .map((line) => `> <font sizeToken=common_footnote_text_style__font_size colorTokenV2=common_level2_base_color>${line}</font>`)
        .join("\n");
}

describe("card-draft-controller", () => {
    const updateAICardBlockListMock = vi.mocked(cardService.updateAICardBlockList);
    const streamAICardContentMock = vi.mocked(cardService.streamAICardContent);
    const clearAICardStreamingContentMock = vi.mocked(cardService.clearAICardStreamingContent);

    beforeEach(() => {
        vi.useFakeTimers();
        updateAICardBlockListMock.mockReset();
        updateAICardBlockListMock.mockResolvedValue(undefined);
        streamAICardContentMock.mockReset();
        streamAICardContentMock.mockResolvedValue(undefined);
        clearAICardStreamingContentMock.mockReset();
        clearAICardStreamingContentMock.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("updateAnswer sends answer block via updateAICardBlockList", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateAnswer("Hello world");
        await vi.advanceTimersByTimeAsync(0);

        const sentContent = updateAICardBlockListMock.mock.calls[0]?.[1] as string;
        const blocks = parseBlocks(sentContent);
        expect(getBlockText(blocks, 0)).toBe("Hello world");
    });

    it("passes getStatusLine result to updateAICardBlockList", async () => {
        const card = makeCard();
        const getStatusLine = vi.fn().mockReturnValue("claude-sonnet | high");
        const ctrl = createCardDraftController({ card, throttleMs: 0, getStatusLine });

        ctrl.updateAnswer("Hello");
        await vi.advanceTimersByTimeAsync(0);

        expect(updateAICardBlockListMock).toHaveBeenCalledTimes(1);
        const opts = updateAICardBlockListMock.mock.calls[0]?.[3];
        expect(opts).toEqual({ statusLine: "claude-sonnet | high" });
    });

    it("omits statusLine option when getStatusLine returns undefined", async () => {
        const card = makeCard();
        const getStatusLine = vi.fn().mockReturnValue(undefined);
        const ctrl = createCardDraftController({ card, throttleMs: 0, getStatusLine });

        ctrl.updateAnswer("Hello");
        await vi.advanceTimersByTimeAsync(0);

        expect(updateAICardBlockListMock).toHaveBeenCalledTimes(1);
        const opts = updateAICardBlockListMock.mock.calls[0]?.[3];
        expect(opts).toBeUndefined();
    });

    it("updateReasoning sends a thinking block", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateReasoning("Analyzing...");
        await vi.advanceTimersByTimeAsync(0);

        const sentContent = updateAICardBlockListMock.mock.calls[0]?.[1] as string;
        expect(sentContent).toContain("Analyzing...");
    });

    it("wraps thinking blocks with quote and font styling", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateReasoning("Analyzing...");
        await vi.advanceTimersByTimeAsync(0);

        const sentContent = updateAICardBlockListMock.mock.calls[0]?.[1] as string;
        const blocks = parseBlocks(sentContent);
        expect(blocks[0]).toEqual({
            type: 1,
            markdown: getProcessBlockText("Analyzing..."),
        });
    });

    it("wraps multi-line thinking blocks with per-line quote and font styling", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        await ctrl.appendThinkingBlock("Reason: 先检查当前目录\n还在整理发送链路\n确认 reply strategy 入口");
        await vi.advanceTimersByTimeAsync(0);

        const sentContent = updateAICardBlockListMock.mock.calls[0]?.[1] as string;
        const blocks = parseBlocks(sentContent);
        expect(blocks[0]).toEqual({
            type: 1,
            markdown: getProcessBlockText("Reason: 先检查当前目录\n还在整理发送链路\n确认 reply strategy 入口"),
        });
        // Each line must have its own `> <font>...</font>` wrapper
        const lines = blocks[0]?.markdown?.split("\n") ?? [];
        expect(lines).toHaveLength(3);
        for (const line of lines) {
            expect(line).toMatch(/^> <font .+>.+<\/font>$/);
        }
    });

    it("wraps tool blocks with quote and font styling", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        await ctrl.updateTool("Exec: pwd");
        await vi.advanceTimersByTimeAsync(0);

        const sentContent = updateAICardBlockListMock.mock.calls[0]?.[1] as string;
        const blocks = parseBlocks(sentContent);
        expect(blocks[0]).toEqual({
            type: 2,
            markdown: getProcessBlockText("Exec: pwd"),
        });
    });

    it("replaces and clears a single live task progress block", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        await ctrl.updateProgress("⏳ 任务处理中\n当前阶段：正在检查配置");
        await vi.advanceTimersByTimeAsync(0);
        await ctrl.updateProgress("⏳ 任务处理中\n当前阶段：正在验证服务");
        await vi.advanceTimersByTimeAsync(0);

        let blocks = parseBlocks(ctrl.getRenderedBlocks());
        expect(blocks).toHaveLength(1);
        expect(getBlockText(blocks, 0)).toContain("正在验证服务");
        expect(getBlockText(blocks, 0)).not.toContain("正在检查配置");

        await ctrl.clearProgress();
        await vi.advanceTimersByTimeAsync(0);

        blocks = parseBlocks(ctrl.getRenderedBlocks());
        expect(blocks).toHaveLength(0);
    });

    it("answer rendering keeps the latest thinking block in the same timeline", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateReasoning("think");
        await vi.advanceTimersByTimeAsync(0);
        expect(updateAICardBlockListMock).toHaveBeenCalledTimes(1);

        const reasoningContent = updateAICardBlockListMock.mock.calls[0]?.[1] as string;
        expect(reasoningContent).toContain("think");

        updateAICardBlockListMock.mockClear();

        ctrl.updateAnswer("answer");
        await vi.advanceTimersByTimeAsync(0);
        expect(updateAICardBlockListMock).toHaveBeenCalledTimes(1);
        const rendered = updateAICardBlockListMock.mock.calls[0]?.[1] as string;
        expect(rendered).toContain("think");
        expect(rendered).toContain("answer");
    });

    it("reasoning is ignored once in answer phase", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateAnswer("answer");
        await vi.advanceTimersByTimeAsync(0);
        updateAICardBlockListMock.mockClear();

        ctrl.updateReasoning("late-reasoning");
        await vi.advanceTimersByTimeAsync(300);
        expect(updateAICardBlockListMock).not.toHaveBeenCalled();
    });

    it("late completed thinking blocks are inserted before the current answer in the same segment", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        await ctrl.updateAnswer("最终答案");
        await vi.advanceTimersByTimeAsync(0);

        await ctrl.appendThinkingBlock("Reason: 先检查当前目录");
        await vi.advanceTimersByTimeAsync(0);

        const blocksJson = ctrl.getRenderedBlocks?.() ?? "";
        expect(blocksJson).toContain("Reason: 先检查当前目录");
        expect(blocksJson).toContain("最终答案");
        expect(blocksJson.indexOf("Reason: 先检查当前目录")).toBeLessThan(
            blocksJson.indexOf("最终答案"),
        );
    });

    it("late completed thinking blocks stay after a tool boundary but before the current answer", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        await ctrl.appendThinkingBlock("Reason: 先检查当前目录");
        await vi.advanceTimersByTimeAsync(0);
        await ctrl.updateTool("Exec: pwd");
        await vi.advanceTimersByTimeAsync(0);
        await ctrl.updateAnswer("pwd 输出是 /Users/sym/clawd");
        await vi.advanceTimersByTimeAsync(0);

        await ctrl.appendThinkingBlock("Reason: 再确认输出后给结论");
        await vi.advanceTimersByTimeAsync(0);

        const blocksJson = ctrl.getRenderedBlocks?.() ?? "";
        const firstThinkingIndex = blocksJson.indexOf("Reason: 先检查当前目录");
        const toolIndex = blocksJson.indexOf("Exec: pwd");
        const lateThinkingIndex = blocksJson.indexOf("Reason: 再确认输出后给结论");
        const answerIndex = blocksJson.indexOf("pwd 输出是 /Users/sym/clawd");

        expect(firstThinkingIndex).toBeGreaterThanOrEqual(0);
        expect(toolIndex).toBeGreaterThan(firstThinkingIndex);
        expect(lateThinkingIndex).toBeGreaterThan(toolIndex);
        expect(answerIndex).toBeGreaterThan(lateThinkingIndex);
    });

    it("reasoning -> answer switch seals only the latest thinking snapshot into the timeline", async () => {
        const sent: string[] = [];
        let resolveInFlight!: () => void;
        updateAICardBlockListMock.mockImplementation(async (_card, content) => {
            sent.push(content);
            if (sent.length === 1) {
                await new Promise<void>((r) => { resolveInFlight = r; });
            }
        });

        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 300 });

        ctrl.updateReasoning("thinking...");
        await vi.advanceTimersByTimeAsync(0);
        expect(sent.length).toBe(1);
        expect(sent[0]).toContain("thinking...");

        ctrl.updateReasoning("still thinking...");
        ctrl.updateAnswer("Hello");

        resolveInFlight();
        await vi.advanceTimersByTimeAsync(300);

        const lastSent = sent[sent.length - 1];
        expect(lastSent).toContain("still thinking...");
        // "still thinking..." is a substring of "thinking...", so substring check
        // is unreliable — verify via parsed blocks instead
        const blocks = parseBlocks(lastSent);
        expect(blocks).toHaveLength(2);
        expect(blocks[0].type).toBe(1); // thinking
        expect(getBlockText(blocks, 0)).toBe(getProcessBlockText("still thinking..."));
        expect(blocks[1].type).toBe(0); // answer
        expect(getBlockText(blocks, 1)).toBe("Hello");
    });

    it("isFailed becomes true when streamAICard throws", async () => {
        updateAICardBlockListMock.mockRejectedValueOnce(new Error("API down"));

        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        expect(ctrl.isFailed()).toBe(false);

        ctrl.updateAnswer("test");
        await vi.advanceTimersByTimeAsync(0);

        expect(ctrl.isFailed()).toBe(true);
    });

    it("updates are ignored after isFailed", async () => {
        updateAICardBlockListMock.mockRejectedValueOnce(new Error("fail"));

        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateAnswer("first");
        await vi.advanceTimersByTimeAsync(0);
        expect(ctrl.isFailed()).toBe(true);

        updateAICardBlockListMock.mockClear();
        ctrl.updateAnswer("second");
        await vi.advanceTimersByTimeAsync(300);
        expect(updateAICardBlockListMock).not.toHaveBeenCalled();
    });

    it("updates are ignored after stop", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateAnswer("before");
        await vi.advanceTimersByTimeAsync(0);
        expect(updateAICardBlockListMock).toHaveBeenCalledTimes(1);

        ctrl.stop();
        updateAICardBlockListMock.mockClear();

        ctrl.updateAnswer("after");
        await vi.advanceTimersByTimeAsync(300);
        expect(updateAICardBlockListMock).not.toHaveBeenCalled();
    });

    it("flush drains all pending and waits for in-flight", async () => {
        const sent: string[] = [];
        let resolveInFlight!: () => void;
        updateAICardBlockListMock.mockImplementation(async (_card, content) => {
            sent.push(content);
            if (sent.length === 1) {
                await new Promise<void>((r) => { resolveInFlight = r; });
            }
        });

        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 300 });

        ctrl.updateAnswer("first");
        await vi.advanceTimersByTimeAsync(0);

        ctrl.updateAnswer("second");

        const flushDone = ctrl.flush();
        resolveInFlight();
        await flushDone;

        expect(sent).toHaveLength(2);
        const blocks0 = parseBlocks(sent[0]);
        const blocks1 = parseBlocks(sent[1]);
        expect(blocks0).toHaveLength(1);
        expect(getBlockText(blocks0, 0)).toBe("first");
        expect(blocks1).toHaveLength(1);
        expect(getBlockText(blocks1, 0)).toBe("second");
    });

    it("throttles real-time answer content updates and keeps blockList unchanged for answer snapshots", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({
            card,
            throttleMs: 1000,
            realTimeStreamEnabled: true,
        }) as any;

        await ctrl.updateAnswer("阶段1答案", { stream: true, renderBlocks: false });
        await vi.advanceTimersByTimeAsync(0);

        expect(streamAICardContentMock).toHaveBeenCalledTimes(1);
        expect(streamAICardContentMock.mock.calls[0]?.[1]).toBe("阶段1答案");
        expect(updateAICardBlockListMock).not.toHaveBeenCalled();

        await ctrl.updateAnswer("阶段2答案-初版", { stream: true, renderBlocks: false });
        await vi.advanceTimersByTimeAsync(300);
        expect(streamAICardContentMock).toHaveBeenCalledTimes(1);
        expect(updateAICardBlockListMock).not.toHaveBeenCalled();

        await ctrl.updateAnswer("阶段2答案-完整版", { stream: true, renderBlocks: false });
        await vi.advanceTimersByTimeAsync(699);
        expect(streamAICardContentMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        expect(streamAICardContentMock).toHaveBeenCalledTimes(2);
        expect(streamAICardContentMock.mock.calls[1]?.[1]).toBe("阶段2答案-完整版");
        expect(updateAICardBlockListMock).not.toHaveBeenCalled();
    });

    it("clears real-time content before committing the active answer at a boundary", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({
            card,
            throttleMs: 0,
            realTimeStreamEnabled: true,
        });

        await ctrl.updateAnswer("阶段答案", { stream: true, renderBlocks: false });
        await vi.advanceTimersByTimeAsync(0);
        expect(streamAICardContentMock).toHaveBeenCalledTimes(1);
        expect(updateAICardBlockListMock).not.toHaveBeenCalled();

        await ctrl.appendTool("工具结果");
        await vi.advanceTimersByTimeAsync(0);

        expect(clearAICardStreamingContentMock).toHaveBeenCalledTimes(1);
        expect(updateAICardBlockListMock).toHaveBeenCalledTimes(1);
        const blocks = parseBlocks(updateAICardBlockListMock.mock.calls[0]?.[1] as string);
        expect(getBlockText(blocks, 0)).toBe("阶段答案");
        expect(getBlockText(blocks, 1)).toContain("工具结果");
    });

    it("drops queued real-time content before a boundary blockList update", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({
            card,
            throttleMs: 1000,
            realTimeStreamEnabled: true,
        });

        await ctrl.updateAnswer("阶段答案", { stream: true, renderBlocks: false });
        await vi.advanceTimersByTimeAsync(0);
        expect(streamAICardContentMock).toHaveBeenCalledTimes(1);

        await ctrl.updateAnswer("阶段答案，后面还有一长段尚未展示的流式内容，需要在边界处直接清空。", {
            stream: true,
            renderBlocks: false,
        });
        await vi.advanceTimersByTimeAsync(300);

        await ctrl.appendTool("工具结果");
        await vi.advanceTimersByTimeAsync(0);

        expect(streamAICardContentMock).toHaveBeenCalledTimes(1);
        expect(clearAICardStreamingContentMock).toHaveBeenCalledTimes(1);
        expect(updateAICardBlockListMock).toHaveBeenCalledTimes(1);
        const blocks = parseBlocks(updateAICardBlockListMock.mock.calls[0]?.[1] as string);
        expect(getBlockText(blocks, 0)).toBe("阶段答案，后面还有一长段尚未展示的流式内容，需要在边界处直接清空。");
        expect(getBlockText(blocks, 1)).toContain("工具结果");
    });

    it("clears real-time content before committing the active answer at an assistant turn boundary", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({
            card,
            throttleMs: 0,
            realTimeStreamEnabled: true,
        });

        await ctrl.updateAnswer("阶段答案", { stream: true, renderBlocks: false });
        await vi.advanceTimersByTimeAsync(0);
        expect(streamAICardContentMock).toHaveBeenCalledTimes(1);
        expect(updateAICardBlockListMock).not.toHaveBeenCalled();

        await ctrl.notifyNewAssistantTurn();
        await vi.advanceTimersByTimeAsync(0);

        expect(clearAICardStreamingContentMock).toHaveBeenCalledTimes(1);
        expect(updateAICardBlockListMock).toHaveBeenCalledTimes(1);
        const blocks = parseBlocks(updateAICardBlockListMock.mock.calls[0]?.[1] as string);
        expect(getBlockText(blocks, 0)).toBe("阶段答案");
    });

    it("getLastContent returns last successfully sent content", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        expect(ctrl.getLastContent()).toBe("");

        ctrl.updateAnswer("content-1");
        await vi.advanceTimersByTimeAsync(0);
        const blocks1 = parseBlocks(ctrl.getLastContent());
        expect(blocks1).toHaveLength(1);
        expect(blocks1[0].type).toBe(0); // answer
        expect(blocks1[0]).toHaveProperty("markdown");
        expect(getBlockText(blocks1, 0)).toBe("content-1");

        ctrl.updateAnswer("content-2");
        await vi.advanceTimersByTimeAsync(0);
        const blocks2 = parseBlocks(ctrl.getLastContent());
        expect(blocks2).toHaveLength(1);
        expect(blocks2[0].type).toBe(0); // answer
        expect(blocks2[0]).toHaveProperty("markdown");
        expect(getBlockText(blocks2, 0)).toBe("content-2");
    });

    it("getLastContent does not update on failed send", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateAnswer("good");
        await vi.advanceTimersByTimeAsync(0);
        // lastSentContent is now JSON CardBlock[]
        const goodContent = ctrl.getLastContent();
        expect(goodContent).toContain("good");

        updateAICardBlockListMock.mockRejectedValueOnce(new Error("fail"));
        ctrl.updateAnswer("bad");
        await vi.advanceTimersByTimeAsync(0);

        // Should still have "good" content, not "bad"
        expect(ctrl.getLastContent()).toBe(goodContent);
    });

    it("waitForInFlight resolves after current in-flight completes", async () => {
        let resolveInFlight!: () => void;
        let inFlightDone = false;
        updateAICardBlockListMock.mockImplementation(async () => {
            await new Promise<void>((r) => { resolveInFlight = r; });
            inFlightDone = true;
        });

        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateAnswer("test");
        await vi.advanceTimersByTimeAsync(0);
        expect(inFlightDone).toBe(false);

        const waitDone = ctrl.waitForInFlight();
        resolveInFlight();
        await waitDone;
        expect(inFlightDone).toBe(true);
    });

    it("notifyNewAssistantTurn: next updateAnswer keeps previous answer and appends new", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateAnswer("Turn 1 content");
        await vi.advanceTimersByTimeAsync(0);
        updateAICardBlockListMock.mockClear();

        ctrl.notifyNewAssistantTurn();
        ctrl.updateAnswer("Turn 2");
        await vi.advanceTimersByTimeAsync(0);

        // After notifyNewAssistantTurn, the old answer is sealed and new answer is appended
        // getFinalAnswerContent should include both turns joined
        const answerText = ctrl.getFinalAnswerContent();
        expect(answerText).toContain("Turn 1 content");
        expect(answerText).toContain("Turn 2");
    });

    it("notifyNewAssistantTurn: without prior answer content does not prepend", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateReasoning("thinking...");
        await vi.advanceTimersByTimeAsync(0);
        updateAICardBlockListMock.mockClear();

        ctrl.notifyNewAssistantTurn();
        ctrl.updateAnswer("first answer");
        await vi.advanceTimersByTimeAsync(0);

        const sentContent = updateAICardBlockListMock.mock.calls[0]?.[1] as string;
        const blocks = parseBlocks(sentContent);
        expect(getBlockText(blocks, 0)).toBe("first answer");
    });

    it("notifyNewAssistantTurn: resets phase to idle, allowing reasoning again", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateAnswer("answer");
        await vi.advanceTimersByTimeAsync(0);
        updateAICardBlockListMock.mockClear();

        ctrl.notifyNewAssistantTurn();
        ctrl.updateReasoning("new thinking");
        await vi.advanceTimersByTimeAsync(0);

        const sentContent = updateAICardBlockListMock.mock.calls[0]?.[1] as string;
        expect(sentContent).toContain("new thinking");
    });

    it("notifyNewAssistantTurn can discard the active answer draft before sealing the turn", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        await ctrl.appendThinkingBlock("Reason: 先检查当前目录");
        await ctrl.updateAnswer("分步推理过程如下：先计算每个人的效率");
        await vi.advanceTimersByTimeAsync(0);

        await ctrl.notifyNewAssistantTurn({ discardActiveAnswer: true });
        await ctrl.updateAnswer("任务预计 3 天完成。");
        await vi.advanceTimersByTimeAsync(0);

        const blocksJson = ctrl.getRenderedBlocks?.() ?? "";
        expect(blocksJson).toContain("Reason: 先检查当前目录");
        expect(blocksJson).toContain("任务预计 3 天完成。");
        expect(blocksJson).not.toContain("分步推理过程如下：先计算每个人的效率");
    });

    it("getLastAnswerContent only tracks answer phase sends", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateReasoning("thinking");
        await vi.advanceTimersByTimeAsync(0);
        expect(ctrl.getLastAnswerContent()).toBe("");
        expect(ctrl.getLastContent()).toContain("thinking");

        ctrl.updateAnswer("answer text");
        await vi.advanceTimersByTimeAsync(0);
        expect(ctrl.getLastAnswerContent()).toBe("answer text");
    });

    it("renders thinking and tool blocks as separate CardBlocks while leaving answer plain", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        ctrl.updateReasoning("先检查改动");
        await vi.advanceTimersByTimeAsync(0);

        expect(typeof ctrl.getRenderedBlocks).toBe("function");
        expect(typeof ctrl.updateTool).toBe("function");

        await ctrl.updateTool("git diff --stat");
        await vi.advanceTimersByTimeAsync(0);

        ctrl.updateAnswer("这里是最终回复");
        await vi.advanceTimersByTimeAsync(0);

        const blocksJson = ctrl.getRenderedBlocks?.() ?? "";
        const blocks = parseBlocks(blocksJson);
        expect(blocks).toHaveLength(3);
        expect(blocks[0].type).toBe(1); // thinking
        expect(blocks[1].type).toBe(2); // tool
        expect(blocks[2].type).toBe(0); // answer
        expect(getBlockText(blocks, 0)).toBe(getProcessBlockText("先检查改动"));
        expect(getBlockText(blocks, 1)).toBe(getProcessBlockText("git diff --stat"));
        expect(getBlockText(blocks, 2)).toBe("这里是最终回复");
    });

    it("renders image blocks with mediaId and text", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        await ctrl.appendImageBlock("@media_123", "系统架构图");
        await vi.advanceTimersByTimeAsync(0);

        const sentContent = updateAICardBlockListMock.mock.calls[0]?.[1] as string;
        const blocks = parseBlocks(sentContent);
        expect(blocks[0]).toEqual({
            type: 3,
            mediaId: "@media_123",
            text: "系统架构图",
        });
    });

    it("replaces the live thinking block instead of appending multiple reasoning snapshots", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        expect(typeof ctrl.getRenderedBlocks).toBe("function");

        ctrl.updateReasoning("第一版思考");
        await vi.advanceTimersByTimeAsync(0);

        ctrl.updateReasoning("第二版思考");
        await vi.advanceTimersByTimeAsync(0);

        const blocksJson = ctrl.getRenderedBlocks?.() ?? "";
        expect(blocksJson).toContain("第二版思考");
        expect(blocksJson).not.toContain("第一版思考");
    });

    it("appends completed thinking blocks without live replacement semantics", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        expect(typeof ctrl.appendThinkingBlock).toBe("function");

        await ctrl.appendThinkingBlock("Reason: 先检查当前目录");
        await vi.advanceTimersByTimeAsync(0);
        await ctrl.appendThinkingBlock("Reason: 再确认 reply strategy 入口");
        await vi.advanceTimersByTimeAsync(0);

        const blocksJson = ctrl.getRenderedBlocks?.() ?? "";
        expect(blocksJson).toContain("Reason: 先检查当前目录");
        expect(blocksJson).toContain("Reason: 再确认 reply strategy 入口");
    });

    it("notifyNewAssistantTurn keeps earlier answer text and appends the next answer turn", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        expect(typeof ctrl.getRenderedContent).toBe("function");

        ctrl.updateAnswer("Turn 1 content");
        await vi.advanceTimersByTimeAsync(0);

        ctrl.notifyNewAssistantTurn();
        ctrl.updateAnswer("Turn 2 short summary");
        await vi.advanceTimersByTimeAsync(0);

        const rendered = ctrl.getRenderedContent?.() ?? "";
        expect(rendered).toContain("Turn 1 content");
        expect(rendered).toContain("Turn 2 short summary");
    });

    it("getFinalAnswerContent returns answer-only text without process block prefixes", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        ctrl.updateReasoning("我先看看");
        await vi.advanceTimersByTimeAsync(0);
        await ctrl.updateTool("git status");
        await vi.advanceTimersByTimeAsync(0);
        ctrl.updateAnswer("最终答案");
        await vi.advanceTimersByTimeAsync(0);

        expect(typeof ctrl.getFinalAnswerContent).toBe("function");
        const answerOnly = ctrl.getFinalAnswerContent?.() ?? "";
        expect(answerOnly).toBe("最终答案");
        expect(answerOnly).not.toContain("思考");
        expect(answerOnly).not.toContain("工具");
    });

    it("keeps html-sensitive tool text inside tool blocks", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        await ctrl.updateTool("<div>hello</div>");
        await vi.advanceTimersByTimeAsync(0);

        const blocksJson = ctrl.getRenderedBlocks?.() ?? "";
        expect(blocksJson).toContain("<div>hello</div>");
    });

    it("sends tool and answer as separate blocks", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        await ctrl.updateTool("Exec: pwd");
        await vi.advanceTimersByTimeAsync(0);
        await ctrl.updateAnswer("当前工作目录是 /Users/sym/clawd");
        await vi.advanceTimersByTimeAsync(0);

        const streamed = updateAICardBlockListMock.mock.calls[updateAICardBlockListMock.mock.calls.length - 1]?.[1] as string;
        const blocks = parseBlocks(streamed);
        expect(blocks).toHaveLength(2);
        expect(blocks[0].type).toBe(2); // tool
        expect(blocks[1].type).toBe(0); // answer
        expect(getBlockText(blocks, 0)).toBe(getProcessBlockText("Exec: pwd"));
        expect(getBlockText(blocks, 1)).toBe("当前工作目录是 /Users/sym/clawd");
    });

    it("sends thinking, tool, and answer as separate blocks", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        await ctrl.updateReasoning("Reason: 先检查当前目录");
        await vi.advanceTimersByTimeAsync(0);
        await ctrl.updateTool("Exec: pwd");
        await vi.advanceTimersByTimeAsync(0);
        await ctrl.updateAnswer("当前工作目录是 /Users/sym/clawd");
        await vi.advanceTimersByTimeAsync(0);

        const streamed = updateAICardBlockListMock.mock.calls[updateAICardBlockListMock.mock.calls.length - 1]?.[1] as string;
        const blocks = parseBlocks(streamed);
        expect(blocks).toHaveLength(3);
        expect(blocks[0].type).toBe(1); // thinking
        expect(blocks[1].type).toBe(2); // tool
        expect(blocks[2].type).toBe(0); // answer
    });

    it("sends multiple adjacent tool blocks as separate entries", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        await ctrl.updateTool("Exec: pwd");
        await vi.advanceTimersByTimeAsync(0);
        await ctrl.updateTool("Exec: printf ok");
        await vi.advanceTimersByTimeAsync(0);

        const streamed = updateAICardBlockListMock.mock.calls[updateAICardBlockListMock.mock.calls.length - 1]?.[1] as string;
        const blocks = parseBlocks(streamed);
        expect(blocks).toHaveLength(2);
        expect(blocks[0].type).toBe(2);
        expect(blocks[1].type).toBe(2);
        expect(getBlockText(blocks, 0)).toBe(getProcessBlockText("Exec: pwd"));
        expect(getBlockText(blocks, 1)).toBe(getProcessBlockText("Exec: printf ok"));
    });

    it("getRenderedBlocks returns JSON blocks array", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        await ctrl.updateTool("Exec: pwd");
        await vi.advanceTimersByTimeAsync(0);
        await ctrl.updateAnswer("当前工作目录是 /Users/sym/clawd");
        await vi.advanceTimersByTimeAsync(0);

        const blocksJson = ctrl.getRenderedBlocks?.() ?? "";
        const blocks = parseBlocks(blocksJson);
        expect(blocks).toHaveLength(2);
        expect(blocks[0].type).toBe(2); // tool
        expect(blocks[1].type).toBe(0); // answer
    });

    it("getRenderedContent returns pure markdown text from answer blocks", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        await ctrl.updateTool("Exec: pwd");
        await vi.advanceTimersByTimeAsync(0);
        await ctrl.updateAnswer("当前工作目录是 /Users/sym/clawd");
        await vi.advanceTimersByTimeAsync(0);

        const markdown = ctrl.getRenderedContent?.() ?? "";
        // Should be pure markdown, not JSON
        expect(markdown).toBe("当前工作目录是 /Users/sym/clawd");
        expect(markdown).not.toContain('"type"');
        expect(markdown).not.toContain('"markdown"');
    });

    it("getRenderedContent joins multiple answer blocks with double newlines", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        ctrl.updateAnswer("Turn 1 answer");
        await vi.advanceTimersByTimeAsync(0);
        ctrl.notifyNewAssistantTurn();
        await ctrl.updateTool("Exec: pwd");
        await vi.advanceTimersByTimeAsync(0);
        ctrl.updateAnswer("Turn 2 answer");
        await vi.advanceTimersByTimeAsync(0);

        const markdown = ctrl.getRenderedContent?.() ?? "";
        expect(markdown).toBe("Turn 1 answer\n\nTurn 2 answer");
        // Should not contain tool block text
        expect(markdown).not.toContain("Exec: pwd");
    });

    it("preserves interleaved answer and tool blocks in event order", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        ctrl.updateAnswer("阶段1答案：准备先检查当前目录");
        await vi.advanceTimersByTimeAsync(0);

        await ctrl.updateTool("🛠️ Exec: pwd");
        await vi.advanceTimersByTimeAsync(0);

        ctrl.notifyNewAssistantTurn();
        ctrl.updateAnswer("阶段2答案：pwd 已返回结果");
        await vi.advanceTimersByTimeAsync(0);

        await ctrl.updateTool("🛠️ Exec: printf ok");
        await vi.advanceTimersByTimeAsync(0);

        ctrl.notifyNewAssistantTurn();
        ctrl.updateAnswer("阶段3答案：两次工具都已完成");
        await vi.advanceTimersByTimeAsync(0);

        const blocksJson = ctrl.getRenderedBlocks?.() ?? "";
        const phase1Index = blocksJson.indexOf("阶段1答案：准备先检查当前目录");
        const tool1Index = blocksJson.indexOf("🛠️ Exec: pwd");
        const phase2Index = blocksJson.indexOf("阶段2答案：pwd 已返回结果");
        const tool2Index = blocksJson.indexOf("🛠️ Exec: printf ok");
        const phase3Index = blocksJson.indexOf("阶段3答案：两次工具都已完成");

        expect(phase1Index).toBeGreaterThanOrEqual(0);
        expect(tool1Index).toBeGreaterThan(phase1Index);
        expect(phase2Index).toBeGreaterThan(tool1Index);
        expect(tool2Index).toBeGreaterThan(phase2Index);
        expect(phase3Index).toBeGreaterThan(tool2Index);
    });

    it("flushes the latest answer frame before appending a new tool block", async () => {
        const sent: string[] = [];
        updateAICardBlockListMock.mockImplementation(async (_card, content) => {
            sent.push(content);
        });

        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 300 }) as any;

        await ctrl.updateAnswer("阶段1答案：初版");
        await vi.advanceTimersByTimeAsync(0);

        await ctrl.updateAnswer("阶段1答案：完整版");
        await ctrl.updateTool("🛠️ Exec: pwd");
        await vi.advanceTimersByTimeAsync(0);

        expect(sent).toHaveLength(3);
        expect(sent[1]).toContain("阶段1答案：完整版");
        expect(sent[1]).not.toContain("🛠️ Exec: pwd");
        expect(sent[2]).toContain("阶段1答案：完整版");
        expect(sent[2]).toContain("🛠️ Exec: pwd");
    });

    it("waits for the tool boundary frame before starting the next answer block", async () => {
        const sent: string[] = [];
        let resolveToolFrame!: () => void;
        updateAICardBlockListMock.mockImplementation(async (_card, content) => {
            sent.push(content);
            if (content.includes("🛠️ Exec: pwd") && !content.includes("阶段2答案")) {
                await new Promise<void>((r) => { resolveToolFrame = r; });
            }
        });

        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 300 }) as any;

        await ctrl.updateAnswer("阶段1答案：准备先检查当前目录");
        await vi.advanceTimersByTimeAsync(0);

        const toolPromise = ctrl.updateTool("🛠️ Exec: pwd");
        await vi.advanceTimersByTimeAsync(0);

        const answerPromise = ctrl.updateAnswer("阶段2答案：pwd 已返回结果");
        await vi.advanceTimersByTimeAsync(0);

        expect(sent[sent.length - 1]).toContain("🛠️ Exec: pwd");
        expect(sent[sent.length - 1]).not.toContain("阶段2答案：pwd 已返回结果");

        resolveToolFrame();
        await toolPromise;
        await answerPromise;
        await vi.advanceTimersByTimeAsync(0);

        expect(sent[sent.length - 1]).toContain("阶段2答案：pwd 已返回结果");
    });

    it("does not send the same rendered timeline twice", async () => {
        const card = makeCard();
        const controller = createCardDraftController({ card, throttleMs: 0 });

        await controller.appendThinkingBlock("先检查目录");
        await vi.advanceTimersByTimeAsync(0);

        await controller.sealActiveThinking();
        await vi.advanceTimersByTimeAsync(0);

        expect(updateAICardBlockListMock).toHaveBeenCalledTimes(1);
    });

    it("does not resend when updateAnswer receives unchanged text", async () => {
        const card = makeCard();
        const controller = createCardDraftController({ card, throttleMs: 0 });

        await controller.updateAnswer("same text");
        await vi.advanceTimersByTimeAsync(0);

        await controller.updateAnswer("same text");
        await vi.advanceTimersByTimeAsync(0);

        expect(updateAICardBlockListMock).toHaveBeenCalledTimes(1);
    });

    it("does not suppress the first fresh-turn reasoning update after pending reset", async () => {
        const card = makeCard();
        const controller = createCardDraftController({ card, throttleMs: 300 });

        await controller.updateReasoning("首次思考");
        await vi.advanceTimersByTimeAsync(0);

        updateAICardBlockListMock.mockClear();

        await controller.updateReasoning("同一条思考");
        await controller.notifyNewAssistantTurn();
        await controller.updateReasoning("同一条思考");
        await vi.advanceTimersByTimeAsync(300);

        expect(updateAICardBlockListMock).toHaveBeenCalledTimes(1);
        const sentContent = updateAICardBlockListMock.mock.calls[0]?.[1] as string;
        expect(sentContent).toContain("同一条思考");
    });

    it("cancels stale queued frame when timeline reverts to last sent content", async () => {
        const card = makeCard();
        const controller = createCardDraftController({ card, throttleMs: 300 });

        await controller.updateAnswer("A");
        await vi.advanceTimersByTimeAsync(0);

        updateAICardBlockListMock.mockClear();

        await controller.updateAnswer("B");
        await controller.updateAnswer("A");
        await vi.advanceTimersByTimeAsync(300);

        expect(updateAICardBlockListMock).not.toHaveBeenCalled();
        const lastContent = controller.getLastContent();
        expect(lastContent).toContain("A");
    });

    it("resends last sent content when reverting while a newer frame is still in-flight", async () => {
        const sent: string[] = [];
        let resolveB!: () => void;
        updateAICardBlockListMock.mockImplementation(async (_card, content) => {
            sent.push(content);
            if (content.includes("B")) {
                await new Promise<void>((r) => { resolveB = r; });
            }
        });

        const card = makeCard();
        const controller = createCardDraftController({ card, throttleMs: 0 });

        await controller.updateAnswer("A");
        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toHaveLength(1);

        const sendB = controller.updateAnswer("B");
        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toHaveLength(2);

        const revertToA = controller.updateAnswer("A");
        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toHaveLength(2);

        resolveB();
        await sendB;
        await revertToA;
        await vi.advanceTimersByTimeAsync(0);

        expect(sent).toHaveLength(3);
        expect(sent[sent.length - 1]).toContain("A");
    });
});
