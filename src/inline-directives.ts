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
 * removed SDK internals are imported.
 */

const AUDIO_TAG_RE = /\[\[\s*audio_as_voice\s*\]\]/gi;
const REPLY_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*([^\]\n]+))\s*\]\]/gi;
const MAX_REPLY_DIRECTIVE_ID_LENGTH = 256;
const BLOCK_SENTINEL_SEED = "\u0000";

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

type FenceSpan = { start: number; end: number };

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Collects ``` / ~~~ fenced regions so whitespace normalization never
 * rewrites code blocks.
 */
function parseFenceSpans(text: string): FenceSpan[] {
  const spans: FenceSpan[] = [];
  const fenceRe = /^([ \t]*)(`{3,}|~{3,})[^\n]*$/gm;
  let match: RegExpExecArray | null;
  let openStart: number | undefined;
  let openMarker: string | undefined;

  while ((match = fenceRe.exec(text)) !== null) {
    const marker = match[2] ?? "";
    if (openStart === undefined) {
      openStart = match.index;
      openMarker = marker;
      continue;
    }
    const sameKind = openMarker?.[0] === marker[0] && marker.length >= (openMarker?.length ?? 0);
    if (!sameKind) {
      continue;
    }
    const lineEnd = match.index + match[0].length;
    spans.push({ start: openStart, end: Math.min(lineEnd + 1, text.length) });
    openStart = undefined;
    openMarker = undefined;
  }

  if (openStart !== undefined) {
    spans.push({ start: openStart, end: text.length });
  }
  return spans;
}

function createBlockSentinel(text: string): string {
  let sentinel = BLOCK_SENTINEL_SEED;
  while (text.includes(sentinel)) {
    sentinel += BLOCK_SENTINEL_SEED;
  }
  return sentinel;
}

function normalizeDirectiveWhitespace(text: string): string {
  const blockSentinel = createBlockSentinel(text);
  const blockPlaceholderRe = new RegExp(`${blockSentinel}(\\d+)${blockSentinel}`, "g");
  const blocks: string[] = [];
  const fenceSpans =
    text.includes("```") || text.includes("~~~") ? parseFenceSpans(text) : ([] as FenceSpan[]);

  let masked = "";
  let cursor = 0;
  for (const span of fenceSpans) {
    blocks.push(text.slice(span.start, span.end));
    masked += `${text.slice(cursor, span.start)}${blockSentinel}${blocks.length - 1}${blockSentinel}`;
    cursor = span.end;
  }
  masked = `${masked}${text.slice(cursor)}`.replace(/(?:(?:^|\n)(?: {4}|\t)[^\n]*)+/gm, (block) => {
    blocks.push(block);
    return `${blockSentinel}${blocks.length - 1}${blockSentinel}`;
  });

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
      text: normalizeDirectiveWhitespace(text),
      audioAsVoice: false,
      replyToCurrent: false,
      hasAudioTag: false,
      hasReplyTag: false,
    };
  }

  let cleaned = text;
  let audioAsVoice = false;
  let hasAudioTag = false;
  let hasReplyTag = false;
  let sawCurrent = false;
  let lastExplicitId: string | undefined;

  cleaned = cleaned.replace(AUDIO_TAG_RE, (match: string, offset: number, source: string) => {
    audioAsVoice = true;
    hasAudioTag = true;
    return stripAudioTag ? replacementPreservesWordBoundary(source, offset, match.length) : match;
  });

  cleaned = cleaned.replace(
    REPLY_TAG_RE,
    (match: string, idRaw: string | undefined, offset: number, source: string) => {
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

  cleaned = normalizeDirectiveWhitespace(cleaned);
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
