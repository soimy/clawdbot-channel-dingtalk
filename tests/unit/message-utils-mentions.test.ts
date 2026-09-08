import { describe, expect, it } from "vitest";
import { extractMessageContent } from "../../src/message-utils";
import { resolveAtAgents } from "../../src/targeting/agent-name-matcher";
import type { DingTalkInboundMessage } from "../../src/types";

function message(overrides: Partial<DingTalkInboundMessage>): DingTalkInboundMessage {
  return {
    msgId: "msg-mention-1",
    msgtype: "text",
    createAt: 1,
    conversationType: "2",
    conversationId: "cid-mention-1",
    senderId: "sender-1",
    chatbotUserId: "bot-1",
    sessionWebhook: "https://example.invalid/session",
    ...overrides,
  } as DingTalkInboundMessage;
}

describe("structured DingTalk mention payloads", () => {
  it("preserves top-level atUsers IDs without mapping them to text names", () => {
    const result = extractMessageContent(
      message({
        atUsers: [{ dingtalkId: "$:user-a" }, { dingtalkId: "$:user-b" }],
        text: { content: "@Alice @Bob 请确认" },
      }),
    );

    expect(result.atUserDingtalkIds).toEqual(["$:user-a", "$:user-b"]);
    expect(result.atMentions?.map((mention) => mention.name)).toEqual(["Alice", "Bob"]);
  });

  it("keeps richText atUserId attached to the corresponding structured mention", () => {
    const result = extractMessageContent(
      message({
        msgtype: "richText",
        atUsers: [{ dingtalkId: "$:person-a" }],
        content: {
          richText: [
            { type: "at", atName: "Alpha助手", atUserId: "$:agent-a" },
            { type: "text", text: " 请处理" },
          ],
        },
      }),
    );

    expect(result.atUserDingtalkIds).toEqual(["$:person-a"]);
    expect(result.atMentions).toEqual([{ name: "Alpha助手", userId: "$:agent-a" }]);
  });

  it("routes an Agent mention while excluding a richText real-user mention", () => {
    const result = extractMessageContent(
      message({
        msgtype: "richText",
        atUsers: [{ dingtalkId: "$:person-a" }],
        content: {
          richText: [
            { type: "at", atName: "Alpha助手", atUserId: "$:agent-a" },
            { type: "at", atName: "Alice", atUserId: "$:person-a" },
          ],
        },
      }),
    );

    const routing = resolveAtAgents(
      result.atMentions || [],
      { agents: { list: [{ id: "agent-a", name: "Alpha助手" }] } },
      result.atUserDingtalkIds,
    );

    expect(routing.matchedAgents).toEqual([
      { agentId: "agent-a", matchSource: "name", matchedName: "Alpha助手" },
    ]);
    expect(routing.unmatchedNames).toEqual([]);
  });
});
