# Architecture

Chinese version: [`architecture.zh-CN.md`](architecture.zh-CN.md)

This document is the canonical source for module boundaries and incremental architecture rules in `openclaw-channel-dingtalk`.

It is written for maintainers, contributors, and AI/code agents working in this repository. When `README.md`, `AGENTS.md`, or `CONTRIBUTING*` summarize architecture rules, this file takes precedence.

## Goals

- Keep feature growth manageable while the repository remains active and PRs are in flight.
- Make it clear where new code should live before doing large physical file moves.
- Reduce accidental boundary erosion, especially in `src/` root-level modules.
- Preserve current runtime behavior while enabling gradual refactoring.

## Working Rule

Use **logical domains first, physical moves second**.

That means:

- New features should follow the domain boundaries in this document even if some existing files are still flat under `src/`.
- Existing files do not need to be moved just to satisfy the target layout.
- When touching old code, prefer small boundary-improving changes over broad structural rewrites.
- Large file moves should be separate from behavior changes whenever possible.

## Core Principles

1. `src/channel.ts` is the assembly root.
   It wires runtime, gateway, outbound entry points, and public exports. It should not accumulate new business logic.
2. Domain modules should answer one class of questions.
   Do not mix routing, persistence, target resolution, and delivery semantics in the same module unless they are inseparable.
3. Avoid generic dumping grounds.
   New code should not default to `utils.ts`, `helpers.ts`, or new root-level `*-service.ts` files unless the logic is truly cross-domain.
4. Prefer deterministic resolution over model inference.
   IDs such as `conversationId` must come from platform payloads, persisted indexes, or explicit operator input, not LLM guessing.
5. Preserve stable low-level boundaries.
   Existing focused modules with clear responsibilities should stay focused instead of absorbing adjacent concerns.

## Host-Version-Aware Behavior

When maintaining the DingTalk plugin, separate behavior that the plugin must implement itself from behavior that becomes active automatically after a host upgrade.

- `before_agent_reply`:
  This is a host reply-runtime hook. As long as DingTalk continues to dispatch through the shared host reply pipeline, newer OpenClaw hosts will apply it automatically without extra plugin wiring.
- `audioAsVoice`:
  This is a shared outbound / reply payload semantic. DingTalk should not depend on private field names or file-extension luck when mapping voice sends. Keep this compatibility logic in the `messaging/` domain.
- `contextVisibility`:
  This is a host channel-level config semantic. The plugin must surface it through its own schema, manifest, setup/docs, or the host support will remain unusable from the DingTalk channel surface.
- `taskFlow`:
  This repository does not directly consume `runtime.taskFlow` today. Do not migrate the normal reply mainline into TaskFlow unless there is a dedicated effort to solve AI Card run / stop lifecycle state across stages.
- Sub-agent session keys:
  On the current minimum supported host version, rely on the host-provided `buildAgentSessionKey` helper instead of synthesizing plugin-local fallback keys, so routing semantics stay aligned with the shared runtime.

## Logical Domains

The current and future code should be reasoned about in these domains, even before the repository is physically rearranged.

### Gateway

Responsible for:

- Stream client lifecycle
- Callback registration and acknowledgement
- Inbound event entry points
- Runtime startup and stop sequencing

Examples:

- `src/channel.ts`
- `src/inbound-handler.ts`
- `src/connection-manager.ts`

Not responsible for:

- Long-term target-directory semantics
- Cross-feature persistence schemas unrelated to inbound delivery
- General-purpose target lookup rules

### Targeting

Responsible for:

- `conversationId` and sender/group identity handling
- Session peer resolution
- Case-preserving ID restoration
- Future group directory and target alias resolution

Examples:

- `src/session-routing.ts`
- `src/session-peer-store.ts`
- `src/peer-id-registry.ts`

Not responsible for:

- Outbound delivery formatting
- AI card lifecycle
- Command-domain persistence

### Messaging

Responsible for:

- Inbound content extraction
- Reply strategy selection
- Text/markdown/media outbound delivery
- Short-lived message context persistence

Examples:

- `src/message-utils.ts`
- `src/send-service.ts`
- `src/reply-strategy*.ts`
- `src/message-context-store.ts`
- `src/media-utils.ts`

### Card

Responsible for:

- AI card create/stream/finalize flow
- Pending card recovery and caches
- Card-specific fallback behavior
- v2 block rendering, draft throttling, run usage recording

Examples:

- `src/card-service.ts`
- `src/card-callback-service.ts`
- `src/card-draft-controller.ts`
- `src/draft-stream-loop.ts`
- `src/run-usage-store.ts`

### Command

Responsible for:

- Slash command parsing and dispatch-oriented domain logic
- Feedback-learning policy and persistence
- Target-scoped learning rules and target sets
- Future extended slash-command capabilities

Examples:

- `src/learning-command-service.ts`
- `src/feedback-learning-service.ts`
- `src/feedback-learning-store.ts`

### Platform

Responsible for:

- Config parsing and schema
- Auth and token caching
- Runtime getters/setters
- Shared logger context
- Common type definitions
- Setup wizard and device auto-registration

Examples:

- `src/config.ts`
- `src/config-schema.ts`
- `src/auth.ts`
- `src/runtime.ts`
- `src/logger-context.ts`
- `src/types.ts`
- `src/device-registration.ts`
- `src/onboarding.ts`

## Planned Directory Layout

The following layout is the planned target structure for future incremental migration. It is a direction, not an immediate requirement.

```text
src/
  channel.ts

  gateway/
    inbound-handler.ts
    connection-manager.ts

  targeting/
    session-routing.ts
    session-peer-store.ts
    peer-id-registry.ts
    group-directory-store.ts
    group-target-resolver.ts

  messaging/
    send-service.ts
    message-utils.ts
    media-utils.ts
    message-context-store.ts
    reply-strategy.ts
    reply-strategy-card.ts
    reply-strategy-markdown.ts
    reply-strategy-with-reaction.ts

  card/
    card-service.ts
    card-callback-service.ts
    card-draft-controller.ts
    draft-stream-loop.ts
    run-usage-store.ts

  command/
    learning-command-service.ts
    feedback-learning-service.ts
    feedback-learning-store.ts

  platform/
    auth.ts
    config.ts
    config-schema.ts
    runtime.ts
    logger-context.ts
    types.ts
    device-registration.ts
    onboarding.ts

  shared/
    persistence-store.ts
    dedup.ts
    utils.ts
```

Notes:

- `src/channel.ts` remains the composition root and public entry for low-level exports.
- New modules should prefer this domain layout even if neighboring legacy files have not moved yet.
- Existing files do not need to be relocated unless the change meaningfully improves clarity or reduces coupling.
- Planned modules such as `group-directory-store.ts` and `group-target-resolver.ts` describe intended placement for future capabilities, not guaranteed current files.

## Important Existing Boundaries

These boundaries are already established and should be preserved.

### `peer-id-registry.ts`

Purpose:

- Restore original case-sensitive DingTalk peer IDs when an upstream session key or input has been lowercased.

It is responsible for:

- `lowercased-id -> original-id` restoration
- In-memory registration of observed IDs

It is not responsible for:

- Reading OpenClaw agent session files
- Group display name lookup
- Manual alias storage
- `conversationId -> title` directory state
- Fuzzy target matching

### `session-peer-store.ts`

Purpose:

- Persist session peer overrides used to merge or redirect OpenClaw session identity.

It is responsible for:

- `sourceKind + sourceId -> logical peerId` overrides
- Session-sharing behavior controlled by owner commands

It is not responsible for:

- DingTalk target discovery
- `groupDisplayName -> conversationId` lookup
- Canonical group metadata storage
- Outbound target resolution for natural-language labels

### Future Target Directory

Any new feature that resolves:

- `groupDisplayName -> conversationId`
- `manual alias -> conversationId`
- historical group title changes

should live in a dedicated targeting module, for example:

- `src/group-directory-store.ts`
- `src/group-target-resolver.ts`

Do not extend `peer-id-registry.ts` or `session-peer-store.ts` to absorb that responsibility.

## Placement Rules For New Code

When adding new code, follow these rules:

- If the code decides *which target a message refers to*, it belongs to the targeting domain.
- If the code decides *how a resolved target is sent to*, it belongs to messaging or card.
- If the code only exists to wire modules together, keep it in `src/channel.ts` and keep it thin.
- If a module starts needing both inbound payload parsing and persistent lookup indexes, split those responsibilities.
- If a helper is only meaningful to one domain, keep it inside that domain instead of moving it to a global utility file.

## Incremental Migration Policy

This repository currently has many root-level files under `src/`. That is acceptable during transition.

The migration policy is:

- No contributor is required to perform a repo-wide file move before shipping a bug fix.
- New features should prefer the target domain boundaries described here.
- Opportunistic refactors are welcome when they reduce confusion without expanding PR scope too much.
- File moves and behavior changes should preferably be separated into different PRs.
- In-flight PRs should not be blocked solely because the repository has not yet been physically reorganized.

## Review Checklist

When reviewing or opening a PR, ask:

1. Does this change add business logic to `src/channel.ts` that should instead live in a focused module?
2. Is this new persistence state part of an existing domain, or is it being attached to the nearest convenient file?
3. Is a target-resolution feature being incorrectly added to session-sharing or case-restoration code?
4. Does the change introduce a new generic helper file that is really hiding missing domain boundaries?
5. Could the same behavior be implemented with a small new module instead of widening an unrelated one?

## Test File Maintenance

Test files should follow the same domain boundaries as source code.

### Scale Thresholds

| Lines | Action |
|-------|--------|
| <500 | Acceptable, no action needed |
| 500-800 | Plan split for future work |
| >800 | Split required before merge |

### Split Strategy

1. **Identify feature domains** — Group tests by the feature they validate
2. **Extract shared mocks** — Create fixture module in `tests/unit/fixtures/`
3. **Split by domain** — Create `source-module-{domain}.test.ts` files with 10-25 tests each
4. **Retain core flows** — Keep end-to-end pipeline tests in the main file
5. **Clean redundancy** — Merge tests that validate identical behavior ≥3 times

### Naming Convention

- Split files: `inbound-handler-quote.test.ts`, `send-service-media.test.ts`
- Fixture files: `tests/unit/fixtures/inbound-handler-fixture.ts`

## Related Entry Points

- `README.md` for project overview and developer entry points
- `CONTRIBUTING.md`
- `CONTRIBUTING.zh-CN.md`
- `AGENTS.md`
