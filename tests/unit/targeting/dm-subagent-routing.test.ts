/**
 * Tests for @mention-based message routing (resolveMessageTarget) and the
 * helpers that act on its decision: dispatchSubAgents, sendUnmatchedAgentNotice,
 * and buildAgentSessionKey.
 *
 * extractMessageContent parses @name tokens from text-type messages and
 * populates atMentions for both group and DM messages, so resolveMessageTarget
 * needs no isGroup guard to enable sub-agent routing in DMs.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractMessageContent } from "../../../src/message-utils";
import { sendBySession } from "../../../src/send-service";
import { resolveAtAgents } from "../../../src/targeting/agent-name-matcher";
import {
  buildAgentSessionKey,
  dispatchSubAgents,
  HostRoutingHelperUnavailableError,
  resolveMessageTarget,
  sendUnmatchedAgentNotice,
} from "../../../src/targeting/agent-routing";
import type { DingTalkConfig, DingTalkInboundMessage, Logger } from "../../../src/types";

vi.mock("../../../src/send-service", () => ({
  sendBySession: vi.fn(),
}));

const runtimeShared = vi.hoisted(() => ({
  getDingTalkRuntime: vi.fn(),
}));

vi.mock("../../../src/runtime", () => ({
  getDingTalkRuntime: runtimeShared.getDingTalkRuntime,
}));

const KNOWN_COMMANDS = new Set([
  "/new",
  "/stop",
  "/clear",
  "/compact",
  "/reasoning",
  "/model",
  "/config",
  "/session",
  "/session-alias",
  "/whoami",
  "/whereami",
  "/help",
  "/status",
  "/tools",
  "/reset",
  "/think",
  "/verbose",
  "/bash",
  "/activation",
  "/agents",
  "/restart",
  "/usage",
]);

vi.mock("openclaw/plugin-sdk/command-auth", () => ({
  maybeResolveTextAlias: (raw: string) => {
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed.startsWith("/")) return null;
    const token = trimmed.match(/^\/([^\s:]+)(?:\s|$)/);
    if (!token) return null;
    const key = `/${token[1]}`;
    return KNOWN_COMMANDS.has(key) ? key : null;
  },
}));

function makeDmMessage(text: string): DingTalkInboundMessage {
  return {
    msgtype: "text",
    text: { content: text },
    conversationType: "1", // direct message
    senderId: "user-001",
    chatbotUserId: "bot-001",
    msgId: "msg-001",
    createAt: Date.now(),
  } as unknown as DingTalkInboundMessage;
}

const cfg = {
  agents: {
    list: [
      { id: "main", name: "Main Agent", default: true },
      { id: "agent-alpha", name: "Alpha助手" },
      { id: "agent-beta", name: "Beta助手" },
    ],
  },
} as OpenClawConfig;

const dingtalkConfig = {
  dmPolicy: "open",
  messageType: "markdown",
} as DingTalkConfig;

const log = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as Logger;

describe("DM sub-agent @mention routing", () => {
  it("extractMessageContent populates atMentions in DM text messages", () => {
    const content = extractMessageContent(makeDmMessage("@agent-alpha 你好"));
    expect(content.atMentions).toHaveLength(1);
    expect(content.atMentions![0].name).toBe("agent-alpha");
  });

  it("strips quoted prefix and still extracts @mention from real message text", () => {
    // Quoted prefix is stripped before @mention extraction in message-utils.ts
    const content = extractMessageContent(makeDmMessage("[引用消息] @agent-alpha 你好"));
    // The quoted prefix is stripped; only the real message text is matched
    expect(content.atMentions).toHaveLength(1);
    expect(content.atMentions![0].name).toBe("agent-alpha");
  });

  it("ignores email-like patterns in DM text", () => {
    const content = extractMessageContent(makeDmMessage("发邮件到 user@example.com 谢谢"));
    expect(content.atMentions).toHaveLength(0);
  });

  it("resolves @id to agent in DM", () => {
    const content = extractMessageContent(makeDmMessage("@agent-alpha 你是谁"));
    const result = resolveAtAgents(content.atMentions!, cfg);
    expect(result.matchedAgents[0]).toMatchObject({ agentId: "agent-alpha", matchSource: "id" });
  });

  it("resolves @name (Chinese) to agent in DM", () => {
    const content = extractMessageContent(makeDmMessage("@Alpha助手 帮我看看"));
    const result = resolveAtAgents(content.atMentions!, cfg);
    expect(result.matchedAgents[0]).toMatchObject({ agentId: "agent-alpha", matchSource: "name" });
  });

  it("routes to multiple agents in DM", () => {
    const content = extractMessageContent(makeDmMessage("@agent-alpha @agent-beta 一起看"));
    const result = resolveAtAgents(content.atMentions!, cfg);
    expect(result.matchedAgents.map((m) => m.agentId)).toEqual(
      expect.arrayContaining(["agent-alpha", "agent-beta"]),
    );
  });

  it("reports invalid agent name", () => {
    const content = extractMessageContent(makeDmMessage("@nonexistent 你好"));
    const result = resolveAtAgents(content.atMentions!, cfg);
    expect(result.matchedAgents).toHaveLength(0);
    expect(result.hasInvalidAgentNames).toBe(true);
  });
});

describe("resolveMessageTarget", () => {
  it("returns 'default' for messages without @mentions", () => {
    const result = resolveMessageTarget({
      extractedContent: { text: "你好", messageType: "text" },
      cfg,
      isGroup: false,
    });

    expect(result).toEqual({ kind: "default" });
  });

  it("returns 'default' for /learn commands even with an @mention", () => {
    const result = resolveMessageTarget({
      extractedContent: {
        text: "/learn list",
        messageType: "text",
        atMentions: [{ name: "agent-alpha" }],
      },
      cfg,
      isGroup: false,
    });

    expect(result).toEqual({ kind: "default" });
  });

  it("routes normal @mention messages to subagent-content", () => {
    const result = resolveMessageTarget({
      extractedContent: {
        text: "@agent-alpha 你好",
        messageType: "text",
        atMentions: [{ name: "agent-alpha" }],
      },
      cfg,
      isGroup: false,
    });

    expect(result.kind).toBe("subagent-content");
    if (result.kind === "subagent-content") {
      expect(result.matchedAgents.map((a) => a.agentId)).toEqual(["agent-alpha"]);
      expect(result.hasInvalidAgentNames).toBe(false);
    }
  });

  it("reports an unmatched agent name as subagent-content with no matches", () => {
    const result = resolveMessageTarget({
      extractedContent: {
        text: "@nonexistent 你好",
        messageType: "text",
        atMentions: [{ name: "nonexistent" }],
      },
      cfg,
      isGroup: false,
    });

    expect(result).toEqual({
      kind: "subagent-content",
      matchedAgents: [],
      unmatchedNames: ["nonexistent"],
      hasInvalidAgentNames: true,
    });
  });

  it.each([
    ["/new", "/new"],
    ["/stop", "/stop"],
    ["/reasoning stream", "/reasoning stream"],
    ["/session-alias show", "/session-alias show"],
  ])("routes '@agent %s' to subagent-command with the @mention stripped", (input, expected) => {
    const result = resolveMessageTarget({
      extractedContent: {
        text: `@agent-alpha ${input}`,
        messageType: "text",
        atMentions: [{ name: "agent-alpha" }],
      },
      cfg,
      isGroup: false,
    });

    expect(result).toEqual({
      kind: "subagent-command",
      agent: expect.objectContaining({ agentId: "agent-alpha" }),
      commandText: expected,
    });
  });

  it("routes group @agent slash commands to subagent-command", () => {
    const result = resolveMessageTarget({
      extractedContent: {
        text: "@agent-alpha /new",
        messageType: "text",
        atMentions: [{ name: "agent-alpha" }],
        atUserDingtalkIds: [],
      },
      cfg,
      isGroup: true,
    });

    expect(result).toEqual({
      kind: "subagent-command",
      agent: expect.objectContaining({ agentId: "agent-alpha" }),
      commandText: "/new",
    });
  });

  it("falls back to a subagent-content notice when a slash command @mentions an unknown agent", () => {
    const result = resolveMessageTarget({
      extractedContent: {
        text: "@nonexistent /new",
        messageType: "text",
        atMentions: [{ name: "nonexistent" }],
      },
      cfg,
      isGroup: false,
    });

    expect(result).toEqual({
      kind: "subagent-content",
      matchedAgents: [],
      unmatchedNames: ["nonexistent"],
      hasInvalidAgentNames: true,
    });
  });
});

describe("sendUnmatchedAgentNotice", () => {
  const mockedSendBySession = vi.mocked(sendBySession);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not include atUserId in the DM fallback notice", async () => {
    await sendUnmatchedAgentNotice({
      unmatchedNames: ["nonexistent"],
      isGroup: false,
      senderId: "user-001",
      dingtalkConfig,
      sessionWebhook: "https://session.webhook",
      log,
    });

    expect(mockedSendBySession).toHaveBeenCalledTimes(1);
    const options = mockedSendBySession.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(options).toMatchObject({ log });
    expect(options).not.toHaveProperty("atUserId");
  });

  it("@s the sender back in the group fallback notice", async () => {
    await sendUnmatchedAgentNotice({
      unmatchedNames: ["nonexistent"],
      isGroup: true,
      senderId: "user-001",
      dingtalkConfig,
      sessionWebhook: "https://session.webhook",
      log,
    });

    const options = mockedSendBySession.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(options).toMatchObject({ log, atUserId: "user-001" });
  });

  it("swallows sendBySession failures", async () => {
    mockedSendBySession.mockRejectedValueOnce(new Error("network error"));

    await expect(
      sendUnmatchedAgentNotice({
        unmatchedNames: ["nonexistent"],
        isGroup: false,
        senderId: "user-001",
        dingtalkConfig,
        sessionWebhook: "https://session.webhook",
        log,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("buildAgentSessionKey", () => {
  it("uses the runtime helper and preserves peer identity for sub-agent sessions", () => {
    const buildAgentSessionKeyMock = vi.fn().mockReturnValue("Group_1:Agent-Alpha");

    const sessionKey = buildAgentSessionKey({
      rt: {
        channel: {
          routing: {
            buildAgentSessionKey: buildAgentSessionKeyMock,
          },
        },
      } as any,
      cfg: {
        session: {
          dmScope: "shared",
          identityLinks: true,
        },
      } as any,
      accountId: "main",
      agentId: "agent-alpha",
      peerKind: "group",
      peerId: "cid_group_1",
    });

    expect(buildAgentSessionKeyMock).toHaveBeenCalledWith({
      agentId: "agent-alpha",
      channel: "dingtalk",
      accountId: "main",
      peer: { kind: "group", id: "cid_group_1" },
      dmScope: "shared",
      identityLinks: true,
    });
    expect(sessionKey).toBe("group_1:agent-alpha");
  });

  it("throws when the host runtime does not expose buildAgentSessionKey", () => {
    expect(() =>
      buildAgentSessionKey({
        rt: {
          channel: {
            routing: {},
          },
        } as any,
        cfg: {} as any,
        accountId: "main",
        agentId: "agent-alpha",
        peerKind: "group",
        peerId: "cid_group_1",
      }),
    ).toThrow(
      "DingTalk sub-agent routing requires runtime.channel.routing.buildAgentSessionKey from the host runtime.",
    );
  });
});

describe("dispatchSubAgents", () => {
  const mockedSendBySession = vi.mocked(sendBySession);

  beforeEach(() => {
    vi.clearAllMocks();
    runtimeShared.getDingTalkRuntime.mockReturnValue({
      channel: {
        routing: {
          buildAgentSessionKey: ({ agentId }: { agentId: string }) => `session-${agentId}`,
        },
      },
    });
  });

  it("surfaces helper-missing warnings from a typed routing error instead of message sniffing", async () => {
    runtimeShared.getDingTalkRuntime.mockReturnValue({ channel: { routing: {} } });
    const handleMessage = vi.fn().mockResolvedValue(undefined);
    await dispatchSubAgents({
      matchedAgents: [{ agentId: "agent-alpha", matchedName: "Alpha助手", matchSource: "name" }],
      cfg,
      accountId: "main",
      data: {
        msgtype: "text",
        text: { content: "@Alpha助手 你好" },
        conversationType: "2",
        conversationId: "cid_group_1",
        senderId: "user-001",
        chatbotUserId: "bot-001",
        msgId: "msg-001",
        createAt: Date.now(),
      } as DingTalkInboundMessage,
      dingtalkConfig,
      sessionWebhook: "https://session.webhook",
      extractedContent: {
        text: "@Alpha助手 你好",
        messageType: "text",
      },
      sessionPeer: { kind: "group", peerId: "cid_group_1" },
      handleMessage,
      downloadMedia: vi.fn().mockResolvedValue(null),
      log,
    });

    expect(mockedSendBySession).toHaveBeenCalledWith(
      dingtalkConfig,
      "https://session.webhook",
      expect.stringContaining("当前宿主版本不支持"),
      expect.objectContaining({
        atUserId: "user-001",
        log,
      }),
    );
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("sends the helper-missing warning only once when multiple agents hit the same host limitation", async () => {
    runtimeShared.getDingTalkRuntime.mockReturnValue({ channel: { routing: {} } });
    const handleMessage = vi.fn().mockResolvedValue(undefined);
    await dispatchSubAgents({
      matchedAgents: [
        { agentId: "agent-alpha", matchedName: "Alpha助手", matchSource: "name" },
        { agentId: "agent-beta", matchedName: "Beta助手", matchSource: "name" },
      ],
      cfg,
      accountId: "main",
      data: {
        msgtype: "text",
        text: { content: "@Alpha助手 @Beta助手 你好" },
        conversationType: "2",
        conversationId: "cid_group_1",
        senderId: "user-001",
        chatbotUserId: "bot-001",
        msgId: "msg-002",
        createAt: Date.now(),
      } as DingTalkInboundMessage,
      dingtalkConfig,
      sessionWebhook: "https://session.webhook",
      extractedContent: {
        text: "@Alpha助手 @Beta助手 你好",
        messageType: "text",
      },
      sessionPeer: { kind: "group", peerId: "cid_group_1" },
      handleMessage,
      downloadMedia: vi.fn().mockResolvedValue(null),
      log,
    });

    expect(mockedSendBySession).toHaveBeenCalledTimes(1);
    expect(mockedSendBySession).toHaveBeenCalledWith(
      dingtalkConfig,
      "https://session.webhook",
      expect.stringContaining("当前宿主版本不支持"),
      expect.objectContaining({
        atUserId: "user-001",
        log,
      }),
    );
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("threads commandText into subAgentOptions and drops the response prefix for targeted commands", async () => {
    const handleMessage = vi.fn().mockResolvedValue(undefined);

    await dispatchSubAgents({
      matchedAgents: [{ agentId: "agent-alpha", matchedName: "Alpha助手", matchSource: "name" }],
      commandText: "/new",
      cfg,
      accountId: "main",
      data: {
        msgtype: "text",
        text: { content: "@Alpha助手 /new" },
        conversationType: "1",
        conversationId: "cid_dm_1",
        senderId: "user-001",
        chatbotUserId: "bot-001",
        msgId: "msg-cmd",
        createAt: Date.now(),
      } as DingTalkInboundMessage,
      dingtalkConfig,
      sessionWebhook: "https://session.webhook",
      extractedContent: {
        text: "@Alpha助手 /new",
        messageType: "text",
      },
      sessionPeer: { kind: "direct", peerId: "user-001" },
      handleMessage,
      downloadMedia: vi.fn().mockResolvedValue(null),
      log,
    });

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        subAgentOptions: {
          agentId: "agent-alpha",
          responsePrefix: "",
          matchedName: "Alpha助手",
          commandText: "/new",
        },
        routeOverride: {
          agentId: "agent-alpha",
          sessionKey: "session-agent-alpha",
          mainSessionKey: "",
        },
      }),
    );
  });

  it("propagates inboundQueueEligible=true to each recursive sub-agent handler", async () => {
    // Round-2 review on PR #592: the previous dispatchSubAgents recursive
    // call did not carry inboundQueueEligible, so @子Agent messages never
    // entered the handler-owned queue on the sub-agent's own session key
    // and still hit reply-session conflicts when the sub-agent was busy.
    // Verify the flag now reaches every recursive handleMessage invocation.
    const handleMessage = vi.fn().mockResolvedValue(undefined);

    await dispatchSubAgents({
      matchedAgents: [
        { agentId: "agent-alpha", matchedName: "Alpha助手", matchSource: "name" },
        { agentId: "agent-beta", matchedName: "Beta助手", matchSource: "name" },
      ],
      cfg,
      accountId: "main",
      data: {
        msgtype: "text",
        text: { content: "@Alpha助手 @Beta助手 hi" },
        conversationType: "1",
        conversationId: "cid_dm_propagation",
        senderId: "user-001",
        chatbotUserId: "bot-001",
        msgId: "msg-propagate",
        createAt: Date.now(),
      } as DingTalkInboundMessage,
      dingtalkConfig,
      sessionWebhook: "https://session.webhook",
      extractedContent: {
        text: "@Alpha助手 @Beta助手 hi",
        messageType: "text",
      },
      sessionPeer: { kind: "direct", peerId: "user-001" },
      handleMessage,
      downloadMedia: vi.fn().mockResolvedValue(null),
      log,
      inboundQueueEligible: true,
    });

    expect(handleMessage).toHaveBeenCalledTimes(2);
    for (const call of handleMessage.mock.calls) {
      expect(call[0].inboundQueueEligible).toBe(true);
      // Recursive handlers must start with the queue-handled guard unset;
      // the first handler pass performs access control and route resolution
      // before re-entering the queued continuation with this flag true.
      expect(call[0].inboundQueueHandled).toBeFalsy();
    }
    // Each recursive handler must also carry its own resolved sub-agent
    // route, so the queue (when entered) serializes on the per-agent
    // sessionKey instead of the parent conversation key.
    expect(handleMessage.mock.calls[0]?.[0]).toMatchObject({
      routeOverride: { agentId: "agent-alpha", sessionKey: "session-agent-alpha" },
    });
    expect(handleMessage.mock.calls[1]?.[0]).toMatchObject({
      routeOverride: { agentId: "agent-beta", sessionKey: "session-agent-beta" },
    });
  });

  it("preserves legacy default (inboundQueueEligible omitted) for synthetic callers", async () => {
    // Synthetic callers (e.g. ask-user reinjection) do not opt into the
    // handler-owned queue. dispatchSubAgents must not silently flip the
    // flag on for them.
    const handleMessage = vi.fn().mockResolvedValue(undefined);

    await dispatchSubAgents({
      matchedAgents: [{ agentId: "agent-alpha", matchedName: "Alpha助手", matchSource: "name" }],
      cfg,
      accountId: "main",
      data: {
        msgtype: "text",
        text: { content: "@Alpha助手 hi" },
        conversationType: "1",
        conversationId: "cid_dm_legacy",
        senderId: "user-001",
        chatbotUserId: "bot-001",
        msgId: "msg-legacy",
        createAt: Date.now(),
      } as DingTalkInboundMessage,
      dingtalkConfig,
      sessionWebhook: "https://session.webhook",
      extractedContent: {
        text: "@Alpha助手 hi",
        messageType: "text",
      },
      sessionPeer: { kind: "direct", peerId: "user-001" },
      handleMessage,
      downloadMedia: vi.fn().mockResolvedValue(null),
      log,
      // inboundQueueEligible intentionally omitted
    });

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0]?.[0]).toMatchObject({
      inboundQueueEligible: undefined,
    });
  });
});
