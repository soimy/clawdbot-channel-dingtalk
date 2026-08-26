import { describe, expect, it } from "vitest";
import { parseInlineDirectives, sanitizeReplyDirectiveId } from "../../src/messaging/inline-directives";

describe("parseInlineDirectives", () => {
  describe("audio tag handling", () => {
    it("detects and strips [[audio_as_voice]] by default", () => {
      const result = parseInlineDirectives("[[audio_as_voice]]讲个故事", {});
      expect(result.audioAsVoice).toBe(true);
      expect(result.hasAudioTag).toBe(true);
      expect(result.text).toBe("讲个故事");
    });

    it("keeps the audio tag when stripAudioTag is false", () => {
      const result = parseInlineDirectives("[[audio_as_voice]]hi", { stripAudioTag: false });
      expect(result.audioAsVoice).toBe(true);
      expect(result.hasAudioTag).toBe(true);
      expect(result.text).toContain("[[audio_as_voice]]");
    });

    it("preserves word boundaries when stripping between words", () => {
      const result = parseInlineDirectives("a[[audio_as_voice]]b", {});
      expect(result.text).toBe("a b");
    });

    it("matches tags with surrounding whitespace", () => {
      const result = parseInlineDirectives("[[ audio_as_voice ]]x", {});
      expect(result.audioAsVoice).toBe(true);
      expect(result.text).toBe("x");
    });
  });

  describe("reply tag handling", () => {
    it("detects [[reply_to_current]] and resolves currentMessageId", () => {
      const result = parseInlineDirectives("答案[[reply_to_current]]", {
        currentMessageId: "m123",
      });
      expect(result.hasReplyTag).toBe(true);
      expect(result.replyToCurrent).toBe(true);
      expect(result.replyToId).toBe("m123");
    });

    it("resolves an explicit [[reply_to:id]]", () => {
      const result = parseInlineDirectives("[[reply_to:abc123]]x", {});
      expect(result.hasReplyTag).toBe(true);
      expect(result.replyToId).toBe("abc123");
      expect(result.replyToExplicitId).toBe("abc123");
      expect(result.text).toBe("x");
    });

    it("keeps the reply tag when stripReplyTags is false", () => {
      const result = parseInlineDirectives("[[reply_to:abc]]x", { stripReplyTags: false });
      expect(result.replyToId).toBe("abc");
      expect(result.text).toContain("[[reply_to:abc]]");
    });

    it("explicit id wins over reply_to_current", () => {
      const result = parseInlineDirectives("[[reply_to_current]][[reply_to:z9]]x", {
        currentMessageId: "m1",
      });
      expect(result.replyToCurrent).toBe(true);
      expect(result.replyToId).toBe("z9");
    });
  });

  describe("reply id sanitization", () => {
    it("does not match malformed reply tags with interior brackets", () => {
      const text = "[[reply_to:bad]id]]x";
      const result = parseInlineDirectives(text, {});
      expect(result.hasReplyTag).toBe(false);
      expect(result.replyToId).toBeUndefined();
      expect(result.text).toBe(text);
    });

    it("drops empty or unsafe-only reply ids", () => {
      const result = parseInlineDirectives("[[reply_to:  ]]x", {});
      expect(result.hasReplyTag).toBe(true);
      expect(result.replyToId).toBeUndefined();
    });

    it("truncates overlong reply ids to 256 chars", () => {
      const long = "a".repeat(300);
      const result = parseInlineDirectives(`[[reply_to:${long}]]x`, {});
      expect(result.replyToId).toBe("a".repeat(256));
    });

    it("sanitizeReplyDirectiveId trims and validates", () => {
      expect(sanitizeReplyDirectiveId("  ab  ")).toBe("ab");
      expect(sanitizeReplyDirectiveId("")).toBeUndefined();
      expect(sanitizeReplyDirectiveId("[]")).toBeUndefined();
      expect(sanitizeReplyDirectiveId("x".repeat(300))).toBe("x".repeat(256));
    });
  });

  describe("code regions protect directive tags", () => {
    it("keeps tags inside inline code as literal text", () => {
      const result = parseInlineDirectives("run `[[audio_as_voice]]` please", {});
      expect(result.audioAsVoice).toBe(false);
      expect(result.hasAudioTag).toBe(false);
      expect(result.text).toBe("run `[[audio_as_voice]]` please");
    });

    it("keeps tags inside fenced code blocks", () => {
      const text = "```\n[[audio_as_voice]]\n```";
      const result = parseInlineDirectives(text, {});
      expect(result.audioAsVoice).toBe(false);
      expect(result.hasAudioTag).toBe(false);
      expect(result.text).toBe(text);
    });

    it("keeps tags inside indented code blocks (blank-line separated)", () => {
      const text = "code:\n\n    [[reply_to:abc123]]";
      const result = parseInlineDirectives(text, {});
      expect(result.hasReplyTag).toBe(false);
      expect(result.replyToId).toBeUndefined();
      expect(result.text).toBe(text);
    });

    it("keeps tags inside lenient indented blocks right after a paragraph", () => {
      const text = "code:\n    [[reply_to:abc123]]";
      const result = parseInlineDirectives(text, {});
      expect(result.hasReplyTag).toBe(false);
      expect(result.replyToId).toBeUndefined();
      expect(result.text).toBe(text);
    });

    it("keeps tags inside tab-indented code blocks", () => {
      const text = "code:\n\n\t[[reply_to:abc123]]";
      const result = parseInlineDirectives(text, {});
      expect(result.hasReplyTag).toBe(false);
      expect(result.replyToId).toBeUndefined();
      expect(result.text).toBe(text);
    });

    it("still parses real directives outside code regions", () => {
      const text = "```\n[[audio_as_voice]]\n```\n说完[[audio_as_voice]]";
      const result = parseInlineDirectives(text, {});
      expect(result.audioAsVoice).toBe(true);
      expect(result.hasAudioTag).toBe(true);
      expect(result.text).not.toContain("说完[[audio_as_voice]]");
      expect(result.text).toContain("```\n[[audio_as_voice]]\n```");
    });
  });

  describe("directives before code blocks (offset regression)", () => {
    it("keeps fenced code whitespace and normalizes prose after stripping a leading audio tag", () => {
      const text = "[[audio_as_voice]]\n```\nx   y\n```\nordinary   prose";
      const result = parseInlineDirectives(text, {});
      expect(result.audioAsVoice).toBe(true);
      expect(result.hasReplyTag).toBe(false);
      expect(result.text).toBe("```\nx   y\n```\nordinary prose");
    });

    it("keeps indented code whitespace after stripping a leading audio tag", () => {
      const text = "[[audio_as_voice]]\n    x   y\nplain   prose";
      const result = parseInlineDirectives(text, {});
      expect(result.audioAsVoice).toBe(true);
      expect(result.text).toBe("    x   y\nplain prose");
    });

    it("treats a reply tag inside a fenced block as literal when an audio tag precedes it", () => {
      const text = "[[audio_as_voice]]\n```\n[[reply_to:abc123]]\n```\nok";
      const result = parseInlineDirectives(text, {});
      expect(result.audioAsVoice).toBe(true);
      expect(result.hasReplyTag).toBe(false);
      expect(result.replyToId).toBeUndefined();
      expect(result.text).toBe("```\n[[reply_to:abc123]]\n```\nok");
    });
  });

  describe("early return for unknown [[tags]]", () => {
    it("returns the original text untouched for unknown tags", () => {
      const text = "hello\n\n\n[[custom]]\nworld";
      const result = parseInlineDirectives(text, {});
      expect(result.text).toBe(text);
      expect(result.audioAsVoice).toBe(false);
      expect(result.hasAudioTag).toBe(false);
      expect(result.hasReplyTag).toBe(false);
    });

    it("does not normalize bracket markdown / LaTeX", () => {
      const text = "x\n\n\n[[a b]]\n\ny";
      const result = parseInlineDirectives(text, {});
      expect(result.text).toBe(text);
    });

    it("returns empty result for empty input", () => {
      expect(parseInlineDirectives("", {})).toEqual({
        text: "",
        audioAsVoice: false,
        replyToCurrent: false,
        hasAudioTag: false,
        hasReplyTag: false,
      });
    });

    it("returns empty result for undefined input", () => {
      const result = parseInlineDirectives(undefined, {});
      expect(result.text).toBe("");
      expect(result.hasAudioTag).toBe(false);
    });
  });

  describe("whitespace normalization", () => {
    it("collapses multiple blank lines when no brackets present", () => {
      const result = parseInlineDirectives("line1\n\n\n\nline2", {});
      expect(result.text).toBe("line1\n\nline2");
    });

    it("preserves fenced code blocks during normalization", () => {
      const text = "```\ncode   keep\n```\ntext   squash";
      const result = parseInlineDirectives(text, {});
      expect(result.text).toContain("```\ncode   keep\n```");
      expect(result.text).toContain("text squash");
    });

    it("normalizes after stripping a real directive", () => {
      const result = parseInlineDirectives("a\n\n\n\nb[[audio_as_voice]]", {});
      expect(result.text).toBe("a\n\nb");
    });
  });
});
