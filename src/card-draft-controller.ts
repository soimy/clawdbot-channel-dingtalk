/**
 * Card draft controller for throttled AI Card streaming updates.
 *
 * The controller keeps a single rendered card timeline made of:
 * - sealed process blocks (`thinking` / `tool`)
 * - an optional live thinking block
 * - accumulated answer turns rendered as JSON CardBlock[]
 *
 * It delegates throttling and single-flight transport guarantees to
 * {@link createDraftStreamLoop}.
 */

import {
    clearAICardStreamingContent,
    streamAICardContent,
    updateAICardBlockList,
} from "./card-service";
import { createDraftStreamLoop } from "./draft-stream-loop";
import type { AICardInstance, CardBlock, Logger } from "./types";

type TimelineEntryKind = "progress" | "thinking" | "tool" | "answer" | "image";

type TimelineEntry = {
    kind: TimelineEntryKind;
    text: string;
    mediaId?: string;
};

// DingTalk markdown variable token definitions:
// https://open.dingtalk.com/document/development/markdown-variable-new
const PROCESS_BLOCK_FONT_SIZE_TOKEN = "common_footnote_text_style__font_size";
// DingTalk markdown variable token definitions:
// https://open.dingtalk.com/document/development/markdown-variable-new
const PROCESS_BLOCK_FONT_COLOR_TOKEN_V2 = "common_level2_base_color";

export interface CardDraftController {
    updateProgress: (text: string) => Promise<void>;
    clearProgress: () => Promise<void>;
    updateAnswer: (text: string, options?: { stream?: boolean; renderBlocks?: boolean }) => Promise<void>;
    updateReasoning: (text: string) => Promise<void>;
    updateThinking: (text: string) => Promise<void>;
    appendThinkingBlock: (text: string) => Promise<void>;
    updateTool: (text: string) => Promise<void>;
    appendTool: (text: string) => Promise<void>;
    /** Append an image block (type=3) with an uploaded mediaId. */
    appendImageBlock: (mediaId: string, text?: string) => Promise<void>;
    appendToolBeforeCurrentAnswer: (text: string) => Promise<void>;
    /** Drop the current answer draft while keeping sealed earlier turns intact. */
    discardCurrentAnswer: () => void;
    /** Signal that a new assistant turn has started (e.g. after a tool call). */
    notifyNewAssistantTurn: (options?: {
        discardActiveAnswer?: boolean;
    }) => Promise<void>;
    startAssistantTurn: () => Promise<void>;
    /** Seal the active thinking entry (keep it in timeline) without removing it. */
    sealActiveThinking: () => Promise<void>;
    flush: () => Promise<void>;
    waitForInFlight: () => Promise<void>;
    stop: () => void;
    isFailed: () => boolean;
    /** Last content successfully sent to card. */
    getLastContent: () => string;
    /** Last answer-only content successfully sent to card. */
    getLastAnswerContent: () => string;
    /** Current answer-only content composed from all completed answer turns. */
    getFinalAnswerContent: () => string;
    /** Current rendered timeline as CardBlock[] JSON string for blockList parameter. */
    getRenderedBlocks: (options?: {
        fallbackAnswer?: string;
        overrideAnswer?: string;
        compactProcessAnswerSpacing?: boolean;
    }) => string;
    /** Current rendered timeline as pure markdown text for content parameter and fallback. */
    getRenderedContent: (options?: {
        fallbackAnswer?: string;
        overrideAnswer?: string;
        compactProcessAnswerSpacing?: boolean;
    }) => string;
    /** Stream answer text to content key for real-time display. Only available when realTimeStreamEnabled=true. */
    streamContent?: (text: string) => Promise<void>;
    /** Clear the streaming content key. Only available when realTimeStreamEnabled=true. */
    clearStreamingContent?: () => Promise<void>;
    /** Whether real-time streaming is enabled. */
    isRealTimeStreamEnabled: () => boolean;
}

function normalizeProcessText(text: string | undefined): string {
    return typeof text === "string" ? text.trim() : "";
}

function normalizeAnswerText(text: string | undefined): string {
    return typeof text === "string" ? text.trimStart() : "";
}

function wrapProcessBlockMarkdown(text: string): string {
    const lines = text.split("\n").filter((line) => line.trim());
    return lines
        .map((line) => `> <font sizeToken=${PROCESS_BLOCK_FONT_SIZE_TOKEN} colorTokenV2=${PROCESS_BLOCK_FONT_COLOR_TOKEN_V2}>${line}</font>`)
        .join("\n");
}

export function createCardDraftController(params: {
    card: AICardInstance;
    throttleMs?: number;
    /** Legacy compatibility: verbose mode previously lowered the throttle. */
    verboseMode?: boolean;
    /** Enable real-time streaming to content key for answer display. */
    realTimeStreamEnabled?: boolean;
    /** Optional callback to get the current statusLine for piggy-backing on blockList updates. */
    getStatusLine?: () => string | undefined;
    log?: Logger;
}): CardDraftController {
    let failed = false;
    let stopped = false;
    let lastSentContent = "";
    let lastQueuedContent = "";
    let inFlightContent = "";
    let lastAnswerContent = "";
    let lastSentStreamingContent = "";
    let lastQueuedStreamingContent = "";
    let inFlightStreamingContent = "";

    let timelineEntries: TimelineEntry[] = [];
    let activeThinkingIndex: number | null = null;
    let activeAnswerIndex: number | null = null;
    let pendingBoundaryPromise: Promise<void> | null = null;

    const effectiveThrottleMs = params.throttleMs ?? (params.verboseMode ? 50 : 300);
    const realTimeStreamEnabled = params.realTimeStreamEnabled ?? false;
    let hasStreamingContent = false;

    const clearPendingStreamingContent = () => {
        contentLoop.resetPending();
        lastQueuedStreamingContent = "";
    };

    const streamContentToCard = async (text: string) => {
        if (!realTimeStreamEnabled) {
            return;
        }
        const normalized = normalizeAnswerText(text);
        if (!normalized.trim()) {
            clearPendingStreamingContent();
            return;
        }
        if (normalized === lastSentStreamingContent) {
            const hasNewerInFlight = !!inFlightStreamingContent && inFlightStreamingContent !== normalized;
            if (!hasNewerInFlight) {
                clearPendingStreamingContent();
                return;
            }
        }
        if (normalized === lastQueuedStreamingContent) {
            return;
        }
        lastQueuedStreamingContent = normalized;
        contentLoop.update(normalized);
    };

    const clearStreamingContentFromCard = async () => {
        clearPendingStreamingContent();
        await contentLoop.waitForInFlight();
        if (!realTimeStreamEnabled || !hasStreamingContent) {
            return;
        }
        try {
            await clearAICardStreamingContent(params.card, params.log);
            hasStreamingContent = false;
            lastSentStreamingContent = "";
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            params.log?.debug?.(`[DingTalk][AICard] Failed to clear streaming content: ${message}`);
        }
    };

    const getFinalAnswerContent = (): string => {
        return timelineEntries
            .filter((entry) => entry.kind === "answer" && entry.text)
            .map((entry) => entry.text)
            .join("\n\n");
    };

    const removeTimelineEntry = (index: number) => {
        timelineEntries.splice(index, 1);
        if (activeThinkingIndex !== null) {
            if (activeThinkingIndex === index) {
                activeThinkingIndex = null;
            } else if (activeThinkingIndex > index) {
                activeThinkingIndex -= 1;
            }
        }
        if (activeAnswerIndex !== null) {
            if (activeAnswerIndex === index) {
                activeAnswerIndex = null;
            } else if (activeAnswerIndex > index) {
                activeAnswerIndex -= 1;
            }
        }
    };

    const appendTimelineEntry = (kind: TimelineEntryKind, text: string): number => {
        timelineEntries.push({ kind, text });
        return timelineEntries.length - 1;
    };

    const updateProgress = async (text: string) => {
        await waitForPendingBoundary();
        if (stopped || failed) {
            return;
        }
        const normalized = normalizeProcessText(text);
        if (!normalized) {
            return;
        }
        const progressIndex = timelineEntries.findIndex((entry) => entry.kind === "progress");
        if (progressIndex >= 0) {
            timelineEntries[progressIndex] = { kind: "progress", text: normalized };
        } else {
            timelineEntries.unshift({ kind: "progress", text: normalized });
            if (activeThinkingIndex !== null) {
                activeThinkingIndex += 1;
            }
            if (activeAnswerIndex !== null) {
                activeAnswerIndex += 1;
            }
        }
        queueRender();
    };

    const clearProgress = async () => {
        await waitForPendingBoundary();
        if (stopped || failed) {
            return;
        }
        const progressIndex = timelineEntries.findIndex((entry) => entry.kind === "progress");
        if (progressIndex < 0) {
            return;
        }
        removeTimelineEntry(progressIndex);
        queueRender();
    };

    const findCurrentSegmentAnswerIndex = (): number | null => {
        return activeAnswerIndex;
    };

    const findLastAnswerEntryIndex = (): number | null => {
        for (let index = timelineEntries.length - 1; index >= 0; index -= 1) {
            if (timelineEntries[index]?.kind === "answer") {
                return index;
            }
        }
        return null;
    };

    const renderTimelineAsBlocks = (options: {
        fallbackAnswer?: string;
        overrideAnswer?: string;
    } = {}): CardBlock[] => {
        const entries = timelineEntries.map((entry) => ({ ...entry }));

        const insertAnswerEntry = (text: string) => {
            const firstImageIndex = entries.findIndex((entry) => entry.kind === "image");
            if (firstImageIndex >= 0) {
                entries.splice(firstImageIndex, 0, { kind: "answer", text });
                return;
            }
            entries.push({ kind: "answer", text });
        };

        const overrideAnswer = normalizeAnswerText(options.overrideAnswer);
        if (overrideAnswer) {
            const lastAnswerIndex = [...entries]
                .map((entry, index) => ({ entry, index }))
                .toReversed()
                .find(({ entry }) => entry.kind === "answer")?.index;
            if (lastAnswerIndex !== undefined) {
                entries[lastAnswerIndex] = { kind: "answer", text: overrideAnswer };
            } else {
                insertAnswerEntry(overrideAnswer);
            }
        } else if (!entries.some((entry) => entry.kind === "answer" && entry.text)) {
            const fallbackAnswer = normalizeAnswerText(options.fallbackAnswer);
            if (fallbackAnswer) {
                insertAnswerEntry(fallbackAnswer);
            }
        }

        const blocks: CardBlock[] = [];
        for (const entry of entries) {
            if (!entry) { continue; }
            switch (entry.kind) {
                case "progress":
                    if (entry.text?.trim()) {
                        blocks.push({ type: 2, markdown: wrapProcessBlockMarkdown(entry.text) });
                    }
                    break;
                case "answer":
                    if (entry.text?.trim()) {
                        blocks.push({ type: 0, markdown: entry.text });
                    }
                    break;
                case "thinking":
                    if (entry.text?.trim()) {
                        blocks.push({ type: 1, markdown: wrapProcessBlockMarkdown(entry.text) });
                    }
                    break;
                case "tool":
                    if (entry.text?.trim()) {
                        blocks.push({ type: 2, markdown: wrapProcessBlockMarkdown(entry.text) });
                    }
                    break;
                case "image":
                    if (entry.mediaId?.trim()) {
                        blocks.push({
                            type: 3,
                            mediaId: entry.mediaId,
                            ...(entry.text?.trim() ? { text: entry.text } : {}),
                        });
                    }
                    break;
            }
        }
        return blocks;
    };

    const sealLiveThinking = () => {
        activeThinkingIndex = null;
    };

    const sealCurrentAnswer = () => {
        activeAnswerIndex = null;
    };

    const discardCurrentAnswer = () => {
        if (activeAnswerIndex === null) {
            return;
        }
        removeTimelineEntry(activeAnswerIndex);
        queueRender();
    };

    const clearPendingRender = () => {
        loop.resetPending();
        lastQueuedContent = "";
    };

    const queueRender = () => {
        const blocks = renderTimelineAsBlocks();
        const rendered = JSON.stringify(blocks);

        // Always update blockList via instances API (throttled)
        if (blocks.length === 0) {
            clearPendingRender();
            return;
        }
        if (rendered === lastSentContent) {
            const hasNewerInFlight = !!inFlightContent && inFlightContent !== rendered;
            if (!hasNewerInFlight) {
                clearPendingRender();
                return;
            }
        }
        if (rendered === lastQueuedContent) {
            return;
        }
        lastQueuedContent = rendered;
        loop.update(rendered);
    };

    const flushBoundaryFrame = async () => {
        if (stopped || failed) {
            return;
        }
        // Clear the live streaming content before committing blockList at the boundary.
        // This drops any queued fake-streaming tail so the empty stream update can stop
        // the animation before the blockList frame lands.
        if (hasStreamingContent) {
            await clearStreamingContentFromCard();
        }
        await loop.flush();
        await loop.waitForInFlight();
        contentLoop.resetThrottleWindow();
        loop.resetThrottleWindow();
    };

    const beginBoundaryFlush = () => {
        if (pendingBoundaryPromise) {
            return pendingBoundaryPromise;
        }
        const current = flushBoundaryFrame().finally(() => {
            if (pendingBoundaryPromise === current) {
                pendingBoundaryPromise = null;
            }
        });
        pendingBoundaryPromise = current;
        return current;
    };

    const waitForPendingBoundary = async () => {
        if (pendingBoundaryPromise) {
            await pendingBoundaryPromise;
        }
    };

    const loop = createDraftStreamLoop({
        throttleMs: effectiveThrottleMs,
        isStopped: () => stopped || failed,
        sendOrEditStreamMessage: async (content: string) => {
            inFlightContent = content;
            try {
                // Use instances API for blockList (not streaming API)
                const statusLine = params.getStatusLine?.();
                await updateAICardBlockList(params.card, content, params.log, statusLine ? { statusLine } : undefined);
                lastSentContent = content;
                lastQueuedContent = "";
                lastAnswerContent = getFinalAnswerContent();
            } catch (err: unknown) {
                failed = true;
                const message = err instanceof Error ? err.message : String(err);
                params.log?.warn?.(`[DingTalk][AICard] BlockList update failed: ${message}`);
            } finally {
                if (inFlightContent === content) {
                    inFlightContent = "";
                }
            }
        },
    });

    const contentLoop = createDraftStreamLoop({
        throttleMs: effectiveThrottleMs,
        isStopped: () => stopped || failed,
        sendOrEditStreamMessage: async (content: string) => {
            inFlightStreamingContent = content;
            try {
                await streamAICardContent(params.card, content, params.log);
                hasStreamingContent = true;
                lastSentStreamingContent = content;
                lastQueuedStreamingContent = "";
                lastAnswerContent = content;
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                params.log?.debug?.(`[DingTalk][AICard] Failed to stream content: ${message}`);
            } finally {
                if (inFlightStreamingContent === content) {
                    inFlightStreamingContent = "";
                }
            }
        },
    });

    const updateReasoning = async (text: string) => {
        await waitForPendingBoundary();
        if (stopped || failed || activeAnswerIndex !== null) {
            return;
        }
        const normalized = normalizeProcessText(text);
        if (!normalized) {
            return;
        }
        if (activeThinkingIndex === null && timelineEntries.length > 0) {
            const lastKind = timelineEntries.at(-1)?.kind;
            if (lastKind && lastKind !== "thinking") {
                await flushBoundaryFrame();
            }
        }
        if (activeThinkingIndex !== null) {
            timelineEntries[activeThinkingIndex] = { kind: "thinking", text: normalized };
        } else {
            activeThinkingIndex = appendTimelineEntry("thinking", normalized);
        }
        queueRender();
    };

    const updateAnswer = async (text: string, options: { stream?: boolean; renderBlocks?: boolean } = {}) => {
        await waitForPendingBoundary();
        if (stopped || failed) {
            return;
        }
        const normalized = normalizeAnswerText(text);
        if (!normalized.trim()) {
            return;
        }
        if (activeAnswerIndex === null && timelineEntries.length > 0) {
            const lastKind = timelineEntries.at(-1)?.kind;
            if (lastKind && lastKind !== "answer") {
                await flushBoundaryFrame();
            }
        }
        sealLiveThinking();
        if (activeAnswerIndex !== null) {
            timelineEntries[activeAnswerIndex] = { kind: "answer", text: normalized };
        } else {
            activeAnswerIndex = appendTimelineEntry("answer", normalized);
        }
        if (options.stream !== false) {
            await streamContentToCard(normalized);
        } else {
            clearPendingStreamingContent();
        }
        const shouldRenderBlocks = options.renderBlocks ?? (options.stream !== false);
        if (!shouldRenderBlocks) {
            clearPendingRender();
            return;
        }
        queueRender();
    };

    const updateTool = async (text: string) => {
        await waitForPendingBoundary();
        if (stopped || failed) {
            return;
        }
        const normalized = normalizeProcessText(text);
        if (!normalized) {
            return;
        }
        if (timelineEntries.length > 0) {
            await flushBoundaryFrame();
        }
        sealLiveThinking();
        sealCurrentAnswer();
        appendTimelineEntry("tool", normalized);
        queueRender();
    };

    const appendThinkingBlock = async (text: string) => {
        await waitForPendingBoundary();
        if (stopped || failed) {
            return;
        }
        const normalized = normalizeProcessText(text);
        if (!normalized) {
            return;
        }
        if (timelineEntries.length > 0) {
            await flushBoundaryFrame();
        }
        sealLiveThinking();
        const currentSegmentAnswerIndex = findCurrentSegmentAnswerIndex();
        if (currentSegmentAnswerIndex !== null) {
            timelineEntries.splice(currentSegmentAnswerIndex, 0, { kind: "thinking", text: normalized });
            if (activeAnswerIndex !== null && activeAnswerIndex >= currentSegmentAnswerIndex) {
                activeAnswerIndex += 1;
            }
        } else {
            sealCurrentAnswer();
            appendTimelineEntry("thinking", normalized);
        }
        queueRender();
    };

    const appendToolBeforeCurrentAnswer = async (text: string) => {
        await waitForPendingBoundary();
        if (stopped || failed) {
            return;
        }
        const normalized = normalizeProcessText(text);
        if (!normalized) {
            return;
        }
        if (timelineEntries.length > 0) {
            await flushBoundaryFrame();
        }
        sealLiveThinking();
        const insertionIndex = findCurrentSegmentAnswerIndex() ?? findLastAnswerEntryIndex();
        if (insertionIndex !== null) {
            timelineEntries.splice(insertionIndex, 0, { kind: "tool", text: normalized });
            if (activeAnswerIndex !== null && activeAnswerIndex >= insertionIndex) {
                activeAnswerIndex += 1;
            }
            if (activeThinkingIndex !== null && activeThinkingIndex >= insertionIndex) {
                activeThinkingIndex += 1;
            }
        } else {
            sealCurrentAnswer();
            appendTimelineEntry("tool", normalized);
        }
        queueRender();
    };

    const notifyNewAssistantTurn = async (options: {
        discardActiveAnswer?: boolean;
    } = {}) => {
        if (stopped || failed) {
            return;
        }
        if (activeAnswerIndex !== null) {
            if (options.discardActiveAnswer) {
                discardCurrentAnswer();
            } else {
                sealCurrentAnswer();
                queueRender();
            }
            await beginBoundaryFlush();
            return;
        }
        if (activeThinkingIndex !== null) {
            removeTimelineEntry(activeThinkingIndex);
            clearPendingRender();
        }
    };

    const appendImageBlock = async (mediaId: string, text = "") => {
        await waitForPendingBoundary();
        if (stopped || failed) {
            return;
        }
        if (!mediaId.trim()) {
            return;
        }
        if (timelineEntries.length > 0) {
            await flushBoundaryFrame();
        }
        sealLiveThinking();
        sealCurrentAnswer();
        timelineEntries.push({ kind: "image", text, mediaId });
        queueRender();
    };

    return {
        updateProgress,
        clearProgress,
        updateAnswer,
        updateReasoning,
        updateThinking: updateReasoning,
        appendThinkingBlock,
        updateTool,
        appendTool: updateTool,
        appendImageBlock,
        appendToolBeforeCurrentAnswer,
        discardCurrentAnswer,
        notifyNewAssistantTurn,
        startAssistantTurn: notifyNewAssistantTurn,
        sealActiveThinking: async () => {
            if (stopped || failed) {
                return;
            }
            if (activeThinkingIndex !== null) {
                sealLiveThinking();
                await beginBoundaryFlush();
            }
        },
        flush: async () => {
            await contentLoop.flush();
            await loop.flush();
        },
        waitForInFlight: async () => {
            await contentLoop.waitForInFlight();
            await loop.waitForInFlight();
        },

        stop: () => {
            stopped = true;
            contentLoop.stop();
            loop.stop();
        },

        isFailed: () => failed,
        getLastContent: () => lastSentContent,
        getLastAnswerContent: () => lastAnswerContent,
        getFinalAnswerContent,
        getRenderedBlocks: (options?: { fallbackAnswer?: string; overrideAnswer?: string }) => {
            const blocks = renderTimelineAsBlocks(options);
            if (blocks.length === 0) {
                return "";
            }
            return JSON.stringify(blocks);
        },
        getRenderedContent: (options?: { fallbackAnswer?: string; overrideAnswer?: string; compactProcessAnswerSpacing?: boolean }) => {
            const blocks = renderTimelineAsBlocks(options);
            // Extract markdown from answer blocks (type: 0) and join with double newlines
            const answerTexts = blocks
                .filter((block) => block.type === 0 && "markdown" in block && block.markdown)
                .map((block) => ("markdown" in block ? block.markdown : ""));
            return answerTexts.join("\n\n");
        },

        streamContent: realTimeStreamEnabled ? streamContentToCard : undefined,
        clearStreamingContent: realTimeStreamEnabled ? clearStreamingContentFromCard : undefined,
        isRealTimeStreamEnabled: () => realTimeStreamEnabled,
    };
}
