/**
 * Inline directive parsing (local implementation).
 *
 * OpenClaw retired the `openclaw/plugin-sdk/text-runtime` subpath in
 * 2026.8.x (docs/plugins/sdk-migration.md: "The August 15 compatibility
 * subpaths ... `text-runtime` ... were retired early"). Its replacement
 * `openclaw/plugin-sdk/text-chunking` only re-exports the directive-tag
 * *stripping* helpers and the `InlineDirectiveParseResult` type - not
 * `parseInlineDirectives` itself.
 *
 * This module reproduces the previous host behaviour inside the plugin so no
 * removed SDK internals are imported. Code-region awareness (fenced,
 * indented, and inline code) is sourced from the public SDK helpers
 * `findCodeRegions` / `isInsideCode` (available since 2026.7.1-2), plus a
 * lenient indented-block fallback matching the host whitespace normalizer so
 * directives inside code are never treated as real voice/reply commands.
 */

import {
  findCodeRegions,
  isInsideCode,
  type CodeRegion,
} from "openclaw/plugin-sdk/text-chunking";

const AUDIO_TAG_RE = /\[\[\s*audio_as_voice\s*\]\]/gi;
const REPLY_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*([^\]\n]+))\s*\]\]/gi;
const MAX_REPLY_DIRECTIVE_ID_LENGTH = 256;
const BLOCK_SENTINEL_SEED = "\uE000";
/** Lenient indented-code-block lines (4 spaces or tab), same rule as the host whitespace normalizer. */
const INDENTED_CODE_LINE_RE = /(?:^|\n)((?: {4}|\t)[^\n]*)(?:\n(?: {4}|\t)[^\n]*)*/g;

export type ParseInlineDirectivesOptions = {
  currentMessageId?: string;
  stripAudioTag?: boolean;
  stripReplyTags?: boolean;
};

export type InlineDirectiveParseResult = {
  text: string;
  audioAsVoice: boolean;
  replyToId?: string;
  replyToExplicitId?: string;
  replyToCurrent: boolean;
  hasAudioTag: boolean;
  hasReplyTag: boolean;
};

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * CommonMark code regions (fenced / indented / inline) from the SDK, extended
 * with a lenient indented-block fallback for lines indented by 4 spaces or a
 * tab that follow a paragraph without a blank separator (the host normalizer
 * protects those too).
 */
function resolveCodeRegions(text: string): CodeRegion[] {
  const regions: CodeRegion[] = [...findCodeRegions(text)];
  const indentRe = new RegExp(INDENTED_CODE_LINE_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = indentRe.exec(text)) !== null) {
    const start = match.index + (match[0].charCodeAt(0) === 10 ? 1 : 0);
    regions.push({ start, end: match.index + match[0].length });
  }
  return mergeCodeRegions(regions);
}

function mergeCodeRegions(regions: CodeRegion[]): CodeRegion[] {
  if (regions.length <= 1) {
    return regions;
  }
  const sorted = [...regions].toSorted((a, b) => a.start - b.start || a.end - b.end);
  const merged: CodeRegion[] = [];
  for (const region of sorted) {
    const last = merged[merged.length - 1];
    if (last && region.start <= last.end) {
      last.end = Math.max(last.end, region.end);
    } else {
      merged.push({ start: region.start, end: region.end });
    }
  }
  return merged;
}

function createBlockSentinel(text: string): string {
  let sentinel = BLOCK_SENTINEL_SEED;
  while (text.includes(sentinel)) {
    sentinel += BLOCK_SENTINEL_SEED;
  }
  return sentinel;
}

function normalizeDirectiveWhitespace(text: string, codeRegions: CodeRegion[] = []): string {
  const blockSentinel = createBlockSentinel(text);
  const blockPlaceholderRe = new RegExp(`${blockSentinel}(\\d+)${blockSentinel}`, "g");
  const blocks: string[] = [];

  let masked = "";
  let cursor = 0;
  for (const region of codeRegions) {
    if (region.start < cursor) {
      continue;
    }
    blocks.push(text.slice(region.start, region.end));
    masked += `${text.slice(cursor, region.start)}${blockSentinel}${blocks.length - 1}${blockSentinel}`;
    cursor = region.end;
  }
  masked += text.slice(cursor);

  return masked
    .replace(/\r\n/g, "\n")
    .replace(/([^\s])[ \t]{2,}([^\s])/g, "$1 $2")
    .replace(/^\n+/, "")
    .replace(/^[ \t](?=\S)/, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()
    .replace(blockPlaceholderRe, (_full, index: string) => blocks[Number(index)] ?? "");
}

function replacementPreservesWordBoundary(source: string, offset: number, length: number): string {
  const before = source[offset - 1];
  const after = source[offset + length];
  return before && after && !/\s/u.test(before) && !/\s/u.test(after) ? " " : "";
}

function stripUnsafeReplyDirectiveChars(value: string): string {
  const chars: string[] = [];
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (
      (code >= 0 && code <= 31) ||
      code === 127 ||
      (code >= 128 && code <= 159) ||
      ch === "[" ||
      ch === "]"
    ) {
      continue;
    }
    chars.push(ch);
  }
  return chars.join("");
}

export function sanitizeReplyDirectiveId(rawReplyToId: string | undefined): string | undefined {
  const trimmed = rawReplyToId?.trim();
  if (!trimmed) {
    return undefined;
  }
  const sanitized = stripUnsafeReplyDirectiveChars(trimmed).trim();
  if (!sanitized) {
    return undefined;
  }
  const chars = Array.from(sanitized);
  if (chars.length > MAX_REPLY_DIRECTIVE_ID_LENGTH) {
    return chars.slice(0, MAX_REPLY_DIRECTIVE_ID_LENGTH).join("");
  }
  return sanitized;
}

export function parseInlineDirectives(
  text: string | undefined,
  options: ParseInlineDirectivesOptions = {},
): InlineDirectiveParseResult {
  const { currentMessageId, stripAudioTag = true, stripReplyTags = true } = options;

  if (!text) {
    return {
      text: "",
      audioAsVoice: false,
      replyToCurrent: false,
      hasAudioTag: false,
      hasReplyTag: false,
    };
  }

  if (!text.includes("[[")) {
    return {
      text: normalizeDirectiveWhitespace(text, resolveCodeRegions(text)),
      audioAsVoice: false,
      replyToCurrent: false,
      hasAudioTag: false,
      hasReplyTag: false,
    };
  }

  // Directives inside code regions are literal text: never voice/reply semantics.
  // Stripping a tag shortens the string, so every pass re-derives regions from
  // the text it actually runs against; offsets from an earlier pass are stale
  // once a preceding tag has been removed.
  const codeRegions = resolveCodeRegions(text);
  let cleaned = text;
  let audioAsVoice = false;
  let hasAudioTag = false;
  let hasReplyTag = false;
  let sawCurrent = false;
  let lastExplicitId: string | undefined;

  cleaned = cleaned.replace(AUDIO_TAG_RE, (match: string, offset: number, source: string) => {
    if (isInsideCode(offset, codeRegions)) {
      return match;
    }
    audioAsVoice = true;
    hasAudioTag = true;
    return stripAudioTag ? replacementPreservesWordBoundary(source, offset, match.length) : match;
  });
  const codeRegionsAfterAudioStrip = resolveCodeRegions(cleaned);

  cleaned = cleaned.replace(
    REPLY_TAG_RE,
    (match: string, idRaw: string | undefined, offset: number, source: string) => {
      if (isInsideCode(offset, codeRegionsAfterAudioStrip)) {
        return match;
      }
      hasReplyTag = true;
      if (idRaw === undefined) {
        sawCurrent = true;
      } else {
        const id = sanitizeReplyDirectiveId(idRaw);
        if (id) {
          lastExplicitId = id;
        }
      }
      return stripReplyTags
        ? replacementPreservesWordBoundary(source, offset, match.length)
        : match;
    },
  );

  // Early return when `[[...]]` matched no known directive: keep the original
  // text untouched instead of running whitespace normalization.
  if (!hasAudioTag && !hasReplyTag) {
    return {
      text,
      audioAsVoice: false,
      replyToCurrent: false,
      hasAudioTag: false,
      hasReplyTag: false,
    };
  }

  cleaned = normalizeDirectiveWhitespace(cleaned, resolveCodeRegions(cleaned));
  const replyToId =
    lastExplicitId ?? (sawCurrent ? normalizeOptionalString(currentMessageId) : undefined);

  return {
    text: cleaned,
    audioAsVoice,
    replyToId,
    replyToExplicitId: lastExplicitId,
    replyToCurrent: sawCurrent,
    hasAudioTag,
    hasReplyTag,
  };
}
