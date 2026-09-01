# Live Task Progress Card Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep one DingTalk AI card visibly updated during long OpenClaw tasks with a concise, sanitized progress summary.

**Architecture:** Extend the card draft timeline with one replaceable progress block. A card-scoped progress controller subscribes to correlated OpenClaw lifecycle/tool events, converts tool names to safe user-facing stages, updates elapsed/completed-step metadata, emits a 30-second heartbeat, and removes the progress block before the final answer is committed.

**Tech Stack:** TypeScript, OpenClaw runtime agent events, Soimy DingTalk AI Card APIs, Vitest.

---

### Task 1: Add a replaceable progress block to the card timeline

**Files:**
- Modify: `src/card-draft-controller.ts`
- Test: `tests/unit/card-draft-controller.test.ts`

1. Write a failing test proving repeated progress updates replace one block and clearing removes it.
2. Run the focused test and confirm it fails because the API is missing.
3. Add `updateProgress` and `clearProgress` with a dedicated timeline entry.
4. Run the focused test and the full controller test file.

### Task 2: Convert runtime events into safe concise progress

**Files:**
- Create: `src/card/card-task-progress.ts`
- Create: `tests/unit/card-task-progress.test.ts`

1. Write failing tests for safe stage labels, correlated tool events, completed-step counts, elapsed time, and a 30-second heartbeat.
2. Confirm failures before implementation.
3. Implement a controller that never renders raw command arguments or tool output.
4. Run the focused tests.

### Task 3: Wire progress into card reply lifecycle

**Files:**
- Modify: `src/reply-strategy-types.ts`
- Modify: `src/inbound-handler.ts`
- Modify: `src/reply-strategy-card.ts`
- Test: `tests/unit/inbound-handler-card-streaming.test.ts`

1. Write a failing integration test that emits runtime tool events and observes updates to the same card.
2. Pass the runtime event surface into the card strategy.
3. Start progress tracking with the card and dispose/clear it on finalization or abort.
4. Run card streaming and inbound handler regression tests.

### Task 4: Build, deploy, and verify

**Files:**
- Build output: `dist/index.js`, `dist/index.d.ts`
- Installed plugin: `/home/claw/.openclaw/npm/projects/soimy-dingtalk-07d9447d75/node_modules/@soimy/dingtalk`

1. Run formatting, type checking, focused tests, full tests, and build.
2. Back up the installed plugin.
3. Copy the verified build and source into the managed plugin location.
4. Restart the OpenClaw gateway.
5. Verify gateway health, DingTalk channel health, plugin load source, and absence of new startup errors.

