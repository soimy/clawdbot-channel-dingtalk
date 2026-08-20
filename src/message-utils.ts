import type {
  AtMention,
  DingTalkInboundMessage,
  MessageContent,
  QuotedInfo,
  SendMessageOptions,
} from "./types";

interface DingTalkDocMeta {
  spaceId: string;
  fileId: string;
}

const UNKNOWN_PERSON_LABEL = "某人";

function parseBizCustomActionUrl(url: string | undefined): DingTalkDocMeta | null {
  if (!url || typeof url !== "string") {
    return null;
  }

  const queryIndex = url.indexOf("?");
  if (queryIndex < 0 || queryIndex === url.length - 1) {
    return null;
  }

  try {
    const params = new URLSearchParams(url.slice(queryIndex + 1));
    const route = params.get("route");
    const type = params.get("type");
    const spaceId = params.get("spaceId");
    const fileId = params.get("fileId");
    if (route !== "previewDentry" || type !== "file" || !spaceId || !fileId) {
      return null;
    }
    return { spaceId, fileId };
  } catch {
    return null;
  }
}

function extractRichTextQuoteParts(
  richText: Array<Record<string, unknown>> | undefined,
): { summary: string; pictureDownloadCode?: string; pictureDownloadCodes?: string[] } | null {
  if (!Array.isArray(richText) || richText.length === 0) {
    return null;
  }

  const textParts: string[] = [];
  const pictureDownloadCodes: string[] = [];

  for (const part of richText) {
    const partType =
      typeof part.msgType === "string"
        ? part.msgType
        : typeof part.type === "string"
          ? part.type
          : undefined;
    const textValue =
      typeof part.content === "string"
        ? part.content
        : typeof part.text === "string"
          ? part.text
          : undefined;

    if ((partType === "text" || partType === undefined) && textValue) {
      textParts.push(textValue);
      continue;
    }
    if (partType === "emoji" && textValue) {
      textParts.push(textValue);
      continue;
    }
    if (partType === "picture") {
      textParts.push("[图片]");
      if (typeof part.downloadCode === "string" && part.downloadCode.trim()) {
        pictureDownloadCodes.push(part.downloadCode.trim());
      }
      continue;
    }
    if (partType === "at") {
      const atName =
        typeof part.atName === "string"
          ? part.atName
          : typeof textValue === "string"
            ? textValue
            : UNKNOWN_PERSON_LABEL;
      textParts.push(`@${atName}`);
      continue;
    }
    if (textValue) {
      textParts.push(textValue);
    }
  }

  const summary = textParts.join("").trim();
  const uniquePictureDownloadCodes = [...new Set(pictureDownloadCodes)];
  const pictureDownloadCode = uniquePictureDownloadCodes[0];
  if (!summary && !pictureDownloadCode) {
    return null;
  }
  return {
    summary,
    pictureDownloadCode,
    pictureDownloadCodes:
      uniquePictureDownloadCodes.length > 0 ? uniquePictureDownloadCodes : undefined,
  };
}

function extractCardContentText(cardContent: unknown): string | undefined {
  if (!Array.isArray(cardContent)) {
    return undefined;
  }
  const collected: string[] = [];
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) {
      return;
    }
    for (const node of nodes) {
      if (node === null || typeof node !== "object" || Array.isArray(node)) {
        continue;
      }
      const element = node as { elementType?: unknown; value?: unknown; children?: unknown };
      if (element.elementType === "TEXT" && typeof element.value === "string") {
        collected.push(element.value);
      }
      walk(element.children);
    }
  };
  walk(cardContent);
  const text = collected
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

function extractAtMentionsFromText(text: string): AtMention[] {
  const mentions: AtMention[] = [];
  const matches = text.matchAll(/(?<!\w)@([^\s@.]+)(?!\.\w)/g);
  for (const match of matches) {
    mentions.push({ name: match[1].trim() });
  }
  return mentions;
}

function trimString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const MAX_CHAT_RECORD_ENTRIES = 30;

function stringifyChatRecordContentValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return trimString(value);
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const content = record.content;
  const contentText =
    typeof content === "string"
      ? trimString(content)
      : content && typeof content === "object"
        ? trimString((content as Record<string, unknown>).text as string | undefined)
        : undefined;

  // Preserve DingTalk's observed chatRecord text priority: explicit text first,
  // then nested content text, then the legacy message fallback.
  return (
    trimString(record.text as string | undefined) ||
    contentText ||
    trimString(record.message as string | undefined)
  );
}

function getChatRecordEntriesSource(content: Record<string, unknown> | undefined): unknown {
  return content?.chatRecord ?? content?.records ?? content?.messages;
}

function formatChatRecordEntries(rawRecord: unknown): string[] {
  let entries = rawRecord;
  if (typeof rawRecord === "string") {
    const trimmed = rawRecord.trim();
    if (!trimmed || trimmed === "[]") {
      return [];
    }
    try {
      entries = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return undefined;
      }
      const record = entry as Record<string, unknown>;
      const sender =
        trimString(record.senderName as string | undefined) ||
        trimString(record.senderNick as string | undefined) ||
        trimString(record.sender as string | undefined) ||
        trimString(record.senderId as string | undefined) ||
        UNKNOWN_PERSON_LABEL;
      const body = stringifyChatRecordContentValue(
        record.content ?? record.text ?? record.message ?? record.body,
      );
      return body ? `${sender}: ${body}` : undefined;
    })
    .filter((line): line is string => Boolean(line))
    .slice(0, MAX_CHAT_RECORD_ENTRIES);
}

function formatChatRecordPreview(
  content: Record<string, unknown> | undefined,
  options: { useTitleAsLabel?: boolean } = {},
): string | undefined {
  const summary = typeof content?.summary === "string" ? content.summary.trim() : "";
  const title = typeof content?.title === "string" ? content.title.trim() : "";
  const rawRecord = getChatRecordEntriesSource(content);
  const recordLines = formatChatRecordEntries(rawRecord);
  const parts: string[] = [];
  if (summary && summary !== "[]") {
    const label = options.useTitleAsLabel
      ? title
        ? `[${title}] `
        : "[聊天记录] "
      : "[聊天记录摘要] ";
    parts.push(`${label}${summary}`);
  }
  if (recordLines.length > 0) {
    parts.push(`[聊天记录内容]\n${recordLines.join("\n")}`);
  }
  return parts.join("\n\n") || undefined;
}

function buildQuotedMessageTypePlaceholder(
  messageType: string | undefined,
  fileName?: string,
): string | undefined {
  switch (messageType) {
    case "text":
      return undefined;
    case "picture":
      return "<media:image>";
    case "audio":
      return "<media:voice>";
    case "video":
      return "<media:video>";
    case "file":
    case "unknownMsgType":
      return fileName ? `<media:file> (${fileName})` : "<media:file>";
    case "interactiveCardFile":
      return "[钉钉文档]";
    case "interactiveCard":
      return "[interactiveCard消息]";
    case "richText":
      return "[富文本消息]";
    default:
      return messageType ? `[Quoted ${messageType}]` : undefined;
  }
}

function buildLegacyQuoteMessagePreview(message: DingTalkInboundMessage["quoteMessage"]): {
  previewText?: string;
  previewMessageType?: string;
  previewSenderId?: string;
} {
  const previewMessageType = trimString(message?.msgtype);
  return {
    previewText:
      trimString(message?.text?.content) || buildQuotedMessageTypePlaceholder(previewMessageType),
    previewMessageType,
    previewSenderId: trimString(message?.senderId),
  };
}

function buildRepliedMessagePreview(params: {
  data: DingTalkInboundMessage;
  repliedMsg: NonNullable<NonNullable<DingTalkInboundMessage["text"]>["repliedMsg"]>;
}): Partial<QuotedInfo> {
  const { data, repliedMsg } = params;
  const repliedMsgType = trimString(repliedMsg.msgType);
  const content = repliedMsg.content;
  const fileName = trimString(content?.fileName);
  const richTextQuote = extractRichTextQuoteParts(content?.richText);
  const docMeta = parseBizCustomActionUrl(content?.biz_custom_action_url);

  if (repliedMsgType === "picture") {
    return {
      mediaDownloadCode: trimString(content?.downloadCode),
      mediaType: trimString(content?.downloadCode) ? "image" : undefined,
      previewText: buildQuotedMessageTypePlaceholder("picture"),
      previewMessageType: "picture",
      previewSenderId: trimString(repliedMsg.senderId),
    };
  }

  if (repliedMsgType === "richText") {
    return {
      mediaDownloadCode: richTextQuote?.pictureDownloadCode,
      mediaType: richTextQuote?.pictureDownloadCode ? "image" : undefined,
      previewText:
        trimString(richTextQuote?.summary) || buildQuotedMessageTypePlaceholder("richText"),
      previewMessageType: "richText",
      previewSenderId: trimString(repliedMsg.senderId),
    };
  }

  if (repliedMsgType === "unknownMsgType") {
    return {
      isQuotedFile: true,
      fileCreatedAt: repliedMsg.createdAt,
      previewText: buildQuotedMessageTypePlaceholder("unknownMsgType", fileName),
      previewMessageType: "unknownMsgType",
      previewFileName: fileName,
      previewSenderId: trimString(repliedMsg.senderId),
    };
  }

  if (repliedMsgType === "file" || repliedMsgType === "audio" || repliedMsgType === "video") {
    const hasFileName = repliedMsgType === "file";
    return {
      isQuotedFile: true,
      fileCreatedAt: repliedMsg.createdAt,
      previewText: buildQuotedMessageTypePlaceholder(
        repliedMsgType,
        hasFileName ? fileName : undefined,
      ),
      previewMessageType: repliedMsgType,
      ...(hasFileName ? { previewFileName: fileName } : {}),
      previewSenderId: trimString(repliedMsg.senderId),
    };
  }

  if (repliedMsgType === "interactiveCard") {
    const isBotCard = repliedMsg.senderId === data.chatbotUserId;
    if (isBotCard) {
      return {
        isQuotedCard: true,
        cardCreatedAt: repliedMsg.createdAt,
        processQueryKey: trimString(data.originalProcessQueryKey),
        previewText:
          trimString(content?.text) ||
          extractCardContentText(content?.cardContent) ||
          buildQuotedMessageTypePlaceholder("interactiveCard"),
        previewMessageType: "interactiveCard",
        previewSenderId: trimString(repliedMsg.senderId),
      };
    }

    return {
      isQuotedDocCard: true,
      fileCreatedAt: repliedMsg.createdAt,
      previewText:
        trimString(content?.text) ||
        extractCardContentText(content?.cardContent) ||
        buildQuotedMessageTypePlaceholder(docMeta ? "interactiveCardFile" : "interactiveCard"),
      previewMessageType: docMeta ? "interactiveCardFile" : "interactiveCard",
      previewSenderId: trimString(repliedMsg.senderId),
    };
  }

  if (repliedMsgType === "chatRecord") {
    return {
      previewText:
        formatChatRecordPreview(content as Record<string, unknown> | undefined, {
          useTitleAsLabel: true,
        }) || buildQuotedMessageTypePlaceholder("chatRecord"),
      previewMessageType: "chatRecord",
      previewSenderId: trimString(repliedMsg.senderId),
    };
  }

  const textPreview =
    trimString(content?.text) ||
    trimString(content?.content) ||
    trimString(richTextQuote?.summary) ||
    buildQuotedMessageTypePlaceholder(repliedMsgType, fileName);

  return {
    mediaDownloadCode: richTextQuote?.pictureDownloadCode,
    mediaType: richTextQuote?.pictureDownloadCode ? "image" : undefined,
    previewText: textPreview,
    previewMessageType: repliedMsgType,
    previewFileName: fileName,
    previewSenderId: trimString(repliedMsg.senderId),
  };
}

/**
 * Auto-detect markdown usage and derive message title.
 * Title extraction follows DingTalk markdown card title constraints.
 */
export function detectMarkdownAndExtractTitle(
  text: string,
  options: SendMessageOptions,
  defaultTitle: string,
): { useMarkdown: boolean; title: string } {
  const hasMarkdown = /^[#*>-]|[*_`#[\]]/.test(text) || text.includes("\n");
  const useMarkdown = options.useMarkdown !== false && (options.useMarkdown || hasMarkdown);

  const title =
    options.title ||
    (useMarkdown
      ? text
          .split("\n")[0]
          .replace(/^[#*\s\->]+/, "")
          .slice(0, 20) || defaultTitle
      : defaultTitle);

  return { useMarkdown, title };
}

function isMarkdownTableSeparator(line: string): boolean {
  const normalized = line.trim();
  if (!normalized.includes("-")) {
    return false;
  }
  const cells = normalized
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
  // DingTalk markdown requires :-: separator format (1 dash minimum).
  // Note: single `-` cells in data rows would also match; this is an accepted trade-off
  // for compatibility with DingTalk's recommended :-: separator format.
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && !trimmed.startsWith("```");
}

function parseMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * Parse alignment from a separator cell.
 * Returns 'left', 'center', 'right', or 'center' (default).
 */
function parseSeparatorAlignment(cell: string): "left" | "center" | "right" {
  const trimmed = cell.trim();
  const hasLeftColon = trimmed.startsWith(":");
  const hasRightColon = trimmed.endsWith(":");
  if (hasLeftColon && hasRightColon) {
    return "center";
  }
  if (hasRightColon) {
    return "right";
  }
  if (hasLeftColon) {
    return "left";
  }
  // Default to center for bare dashes (standard markdown)
  return "center";
}

/**
 * Build separator row from alignment array.
 */
function buildSeparatorRow(alignments: ("left" | "center" | "right")[]): string {
  const cells = alignments.map((align) => {
    if (align === "left") {
      return ":---";
    }
    if (align === "right") {
      return "---:";
    }
    return ":---:";
  });
  return "|" + cells.join("|") + "|";
}

/**
 * Render markdown table rows preserving original alignment.
 * Extracts alignment from the separator row and applies it to output.
 */
function renderMarkdownTable(headerLine: string, separatorLine: string, dataLines: string[]): string {
  const headerCells = parseMarkdownTableRow(headerLine);
  const separatorCells = parseMarkdownTableRow(separatorLine);
  const dataRows = dataLines.map(parseMarkdownTableRow).filter((cells) => cells.length > 0);

  if (headerCells.length === 0) {
    return "";
  }

  const colCount = Math.max(
    headerCells.length,
    separatorCells.length,
    ...dataRows.map((cells) => cells.length),
  );

  // Extract alignments from separator
  const alignments: ("left" | "center" | "right")[] = [];
  for (let i = 0; i < colCount; i++) {
    const sepCell = separatorCells[i] || "";
    alignments.push(parseSeparatorAlignment(sepCell));
  }

  const separator = buildSeparatorRow(alignments);

  const allRows = [headerCells, ...dataRows];
  const rendered = allRows
    .map((cells) => {
      const padded = cells.length < colCount
        ? [...cells, ...Array(colCount - cells.length).fill("")]
        : cells;
      return "|" + padded.join("|") + "|";
    });

  // Insert separator after header row (works for header-only tables too)
  rendered.splice(1, 0, separator);

  return rendered.join("\n");
}

/**
 * Convert markdown tables to DingTalk-compatible format.
 * DingTalk's markdown renderer supports left/center/right alignment (:---, :---:, ---:).
 * This function preserves the original alignment from the separator row.
 * Tables inside code fences are preserved unchanged.
 *
 * Note: Despite the function name, this now produces DingTalk-compatible
 * markdown tables rather than plain text. The name is preserved for API
 * compatibility with the `convertMarkdownTables` config option.
 */
export function convertMarkdownTablesToPlainText(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let index = 0;
  let inCodeFence = false;

  while (index < lines.length) {
    const line = lines[index] || "";
    if (line.trim().startsWith("```")) {
      inCodeFence = !inCodeFence;
      output.push(line);
      index += 1;
      continue;
    }

    if (
      !inCodeFence &&
      index + 1 < lines.length &&
      isMarkdownTableRow(line) &&
      isMarkdownTableSeparator(lines[index + 1] || "")
    ) {
      const headerLine = line;
      const separatorLine = lines[index + 1] || "";
      const dataLines: string[] = [];
      index += 2;
      while (index < lines.length && isMarkdownTableRow(lines[index] || "")) {
        dataLines.push(lines[index] || "");
        index += 1;
      }
      const renderedTable = renderMarkdownTable(headerLine, separatorLine, dataLines);
      // Ensure blank line before table for DingTalk markdown rendering
      const lastOutput = output[output.length - 1];
      if (lastOutput !== undefined && lastOutput.trim() !== "") {
        output.push("");
      }
      output.push(renderedTable);
      continue;
    }

    output.push(line);
    index += 1;
  }

  return output.join("\n");
}

export function extractMessageContent(data: DingTalkInboundMessage): MessageContent {
  const msgtype = data.msgtype || "text";
  const atMentions: AtMention[] = [];

  // 提取通过 @picker 选中的真实用户的 dingtalkId
  // 这些是真实钉钉用户，不包含 agent 名（如 @frontend）
  const atUserDingtalkIds = data.atUsers?.map((u) => u.dingtalkId).filter(Boolean);

  const formatQuotedContent = (): QuotedInfo | null => {
    const textField = data.text;

    if (textField?.isReplyMsg && textField?.repliedMsg) {
      const repliedMsg = textField.repliedMsg;
      const repliedMsgType = trimString(repliedMsg.msgType);
      const content = repliedMsg.content;
      const repliedMsgId = trimString(repliedMsg.msgId) || trimString(data.originalMsgId);
      const repliedPreview = buildRepliedMessagePreview({ data, repliedMsg });

      if (repliedMsgType === "picture" && content?.downloadCode) {
        return {
          mediaDownloadCode: content.downloadCode,
          mediaType: "image",
          ...repliedPreview,
        };
      }

      if (repliedMsgType === "richText") {
        const richTextQuote = extractRichTextQuoteParts(content?.richText);
        if (richTextQuote) {
          return {
            msgId: repliedMsgId,
            mediaDownloadCode: richTextQuote.pictureDownloadCode,
            mediaType: richTextQuote.pictureDownloadCode ? "image" : undefined,
            ...repliedPreview,
          };
        }
      }

      if (repliedMsgType === "unknownMsgType") {
        return {
          isQuotedFile: true,
          fileCreatedAt: repliedMsg.createdAt,
          msgId: repliedMsgId,
          ...repliedPreview,
        };
      }

      if (repliedMsgType === "file" || repliedMsgType === "audio" || repliedMsgType === "video") {
        return {
          isQuotedFile: true,
          fileCreatedAt: repliedMsg.createdAt,
          fileDownloadCode: trimString(content?.downloadCode),
          msgId: repliedMsgId,
          ...repliedPreview,
        };
      }

      if (repliedMsgType === "interactiveCard") {
        const isBotCard = repliedMsg.senderId === data.chatbotUserId;
        if (isBotCard) {
          return {
            isQuotedCard: true,
            cardCreatedAt: repliedMsg.createdAt,
            processQueryKey: data.originalProcessQueryKey,
            msgId: repliedMsgId,
            ...repliedPreview,
          };
        }

        return {
          isQuotedDocCard: true,
          fileCreatedAt: repliedMsg.createdAt,
          msgId: repliedMsgId,
          ...repliedPreview,
        };
      }

      if (repliedMsgType && repliedMsgId) {
        return { msgId: repliedMsgId, ...repliedPreview };
      }

      // No msgType — backward compat: extract text or richText from content.
      if (trimString(content?.text) || trimString(content?.content)) {
        return repliedMsgId ? { msgId: repliedMsgId, ...repliedPreview } : null;
      }

      if (content?.richText && Array.isArray(content.richText)) {
        const richTextQuote = extractRichTextQuoteParts(content.richText);
        if (richTextQuote) {
          return {
            msgId: repliedMsgId,
            mediaDownloadCode: richTextQuote.pictureDownloadCode,
            mediaType: richTextQuote.pictureDownloadCode ? "image" : undefined,
            ...repliedPreview,
          };
        }
      }
    }

    if (textField?.isReplyMsg && !textField?.repliedMsg && data.originalMsgId) {
      return {
        msgId: data.originalMsgId,
      };
    }

    if (data.quoteMessage) {
      if (data.quoteMessage.msgId) {
        return {
          msgId: data.quoteMessage.msgId,
          ...buildLegacyQuoteMessagePreview(data.quoteMessage),
        };
      }
    }

    return null;
  };

  const quoted = formatQuotedContent();

  if (msgtype === "text") {
    const textContent = data.text?.content?.trim() || "";

    // Strip quoted prefix before extracting @mentions to avoid matching @names inside quotes.
    const textForAtExtraction = textContent.replace(/^\[引用[^\]]*\]\s*/, "");
    atMentions.push(...extractAtMentionsFromText(textForAtExtraction));

    return {
      text: textContent || quoted?.previewText || "",
      messageType: "text",
      quoted: quoted ?? undefined,
      atMentions,
      atUserDingtalkIds,
    };
  }

  if (msgtype === "richText") {
    const richTextParts = data.content?.richText || [];
    let text = "";
    const pictureDownloadCodes: string[] = [];
    // Keep first image downloadCode while preserving readable text and @mention parts.
    for (const part of richTextParts) {
      if (part.text && (part.type === "text" || part.type === undefined)) {
        text += part.text;
      }
      if (part.type === "at" && part.atName) {
        text += `@${part.atName} `;
        // 提取 @ 提及信息，包括 atUserId
        atMentions.push({
          name: part.atName.trim(),
          userId: part.atUserId,
        });
      }
      if (part.type === "picture" && part.downloadCode) {
        pictureDownloadCodes.push(part.downloadCode);
      }
    }
    const uniquePictureDownloadCodes = [...new Set(pictureDownloadCodes)];
    const pictureDownloadCode = uniquePictureDownloadCodes[0];
    return {
      text: text.trim() || (pictureDownloadCode ? "<media:image>" : "[富文本消息]"),
      mediaPath: pictureDownloadCode,
      mediaPaths: uniquePictureDownloadCodes.length > 0 ? uniquePictureDownloadCodes : undefined,
      mediaType: pictureDownloadCode ? "image" : undefined,
      mediaTypes:
        uniquePictureDownloadCodes.length > 0
          ? uniquePictureDownloadCodes.map(() => "image")
          : undefined,
      messageType: "richText",
      quoted: quoted ?? undefined,
      atMentions,
      atUserDingtalkIds,
    };
  }

  if (msgtype === "picture") {
    return {
      text: "<media:image>",
      mediaPath: data.content?.downloadCode,
      mediaType: "image",
      messageType: "picture",
      atMentions,
      atUserDingtalkIds,
    };
  }

  if (msgtype === "audio") {
    return {
      text: data.content?.recognition || "<media:voice>",
      mediaPath: data.content?.downloadCode,
      mediaType: "audio",
      messageType: "audio",
      atMentions,
      atUserDingtalkIds,
    };
  }

  if (msgtype === "video") {
    return {
      text: "<media:video>",
      mediaPath: data.content?.downloadCode,
      mediaType: "video",
      messageType: "video",
      atMentions,
      atUserDingtalkIds,
    };
  }

  if (msgtype === "file") {
    return {
      text: `<media:file> (${data.content?.fileName || "文件"})`,
      mediaPath: data.content?.downloadCode,
      mediaType: "file",
      messageType: "file",
      atMentions,
      atUserDingtalkIds,
    };
  }

  if (msgtype === "markdown") {
    const mdText = typeof data.content?.text === "string" ? data.content.text.trim() : "";
    atMentions.push(...extractAtMentionsFromText(mdText));
    return {
      text: mdText || "[markdown消息]",
      messageType: "markdown",
      quoted: quoted ?? undefined,
      atMentions,
      atUserDingtalkIds,
    };
  }

  if (msgtype === "interactiveCard") {
    const docMeta = parseBizCustomActionUrl(data.content?.biz_custom_action_url);
    if (docMeta) {
      return {
        text: "[钉钉文档]\n\n",
        messageType: "interactiveCardFile",
        docSpaceId: docMeta.spaceId,
        docFileId: docMeta.fileId,
        quoted: quoted ?? undefined,
        atMentions,
        atUserDingtalkIds,
      };
    }
    return {
      text: data.text?.content?.trim() || "[interactiveCard消息]",
      messageType: msgtype,
      quoted: quoted ?? undefined,
      atMentions,
      atUserDingtalkIds,
    };
  }
  if (msgtype === "chatRecord") {
    const content = data.content as Record<string, unknown> | undefined;
    const summary = typeof content?.summary === "string" ? content.summary.trim() : "";
    const rawRecord = getChatRecordEntriesSource(content);
    const chatRecordText = formatChatRecordPreview(content);
    if (
      summary === "[]" ||
      (typeof rawRecord === "string" && rawRecord.trim() === "[]") ||
      (Array.isArray(rawRecord) && rawRecord.length === 0)
    ) {
      return {
        text: "[系统提示] 没有读到引用记录（chatRecord 为空）。请改用逐条转发、复制原文，或重新转发非空聊天记录。",
        messageType: "chatRecord",
        quoted: quoted ?? undefined,
        atMentions,
        atUserDingtalkIds,
      };
    }
    if (chatRecordText) {
      return {
        text: chatRecordText,
        messageType: "chatRecord",
        quoted: quoted ?? undefined,
        atMentions,
        atUserDingtalkIds,
      };
    }
    return {
      text: "[chatRecord消息: 无可读内容]",
      messageType: "chatRecord",
      quoted: quoted ?? undefined,
      atMentions,
      atUserDingtalkIds,
    };
  }

  return {
    text: data.text?.content?.trim() || `[${msgtype}消息]`,
    messageType: msgtype,
    quoted: quoted ?? undefined,
    atMentions,
    atUserDingtalkIds,
  };
}
