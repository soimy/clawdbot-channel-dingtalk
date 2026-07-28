import { jsonResult } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { readStringParam } from "openclaw/plugin-sdk/param-readers";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { getConfig, stripTargetPrefix } from "../config";
import { getLogger } from "../logger-context";
import { resolveOriginalPeerId } from "../peer-id-registry";
import { hasConfiguredSecretInput } from "../secret-input";
import { sendMedia, sendMessage } from "../send-service";
import { parseBooleanLike } from "../utils";

function readBooleanLikeParam(params: Record<string, unknown>, key: string): boolean | undefined {
  return parseBooleanLike(params[key]);
}

function readSharedAudioAsVoiceParam(params: Record<string, unknown>): boolean {
  const sharedValue = readBooleanLikeParam(params, "audioAsVoice");
  if (sharedValue !== undefined) {
    return sharedValue;
  }
  return readBooleanLikeParam(params, "asVoice") === true;
}

function resolveConversationIdFromSessionKey(sessionKey?: string | null): string | undefined {
  const trimmed = sessionKey?.trim();
  if (!trimmed) {
    return undefined;
  }

  const markers = [":group:", ":channel:", ":direct:"] as const;
  const marker = markers.find((candidate) => trimmed.includes(candidate));
  if (!marker) {
    return undefined;
  }

  const suffix = trimmed.slice(trimmed.indexOf(marker) + marker.length);
  const threadMarker = ":topic:";
  const threadIndex = suffix.indexOf(threadMarker);
  const conversationId = (threadIndex >= 0 ? suffix.slice(0, threadIndex) : suffix).trim();
  return conversationId || undefined;
}

function inferCardOwnerIdFromTarget(target: string): string | undefined {
  const trimmed = target.trim();
  if (!trimmed || trimmed.startsWith("cid")) {
    return undefined;
  }
  return trimmed;
}

function describeDingTalkMessageTool(cfg: OpenClawConfig) {
  const config = getConfig(cfg);
  const configured = Boolean(config.clientId && hasConfiguredSecretInput(config.clientSecret));
  if (!configured && !(config.accounts && Object.keys(config.accounts).length > 0)) {
    return { actions: [], capabilities: [], schema: null };
  }
  return {
    actions: ["send"] as const,
    capabilities: [],
    schema: null,
  };
}

export function createDingTalkMessageActions(): ChannelMessageActionAdapter {
  return {
    describeMessageTool: ({ cfg }) => describeDingTalkMessageTool(cfg),
    supportsAction: ({ action }) => action === "send",
    extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),
    handleAction: async ({ action, params, cfg, accountId, dryRun, mediaLocalRoots, sessionKey }) => {
      if (action !== "send") {
        throw new Error(`Action ${action} is not supported for provider dingtalk.`);
      }

      const to = readStringParam(params, "to", { required: true });
      const mediaInput =
        readStringParam(params, "media", { trim: false }) ??
        readStringParam(params, "path", { trim: false }) ??
        readStringParam(params, "filePath", { trim: false }) ??
        readStringParam(params, "mediaUrl", { trim: false });

      const hasMedia = Boolean(mediaInput && mediaInput.trim());
      const caption = readStringParam(params, "caption", { allowEmpty: true }) ?? "";
      let message =
        readStringParam(params, "message", {
          required: !hasMedia,
          allowEmpty: true,
        }) ?? "";

      if (!message.trim() && caption.trim()) {
        message = caption;
      }

      const asVoice = readSharedAudioAsVoiceParam(params);
      const requestedMediaType = readStringParam(params, "mediaType") as
        | "image"
        | "voice"
        | "video"
        | "file"
        | undefined;

      const target = resolveOriginalPeerId(stripTargetPrefix(to).targetId);

      if (dryRun) {
        return jsonResult({
          ok: true,
          dryRun: true,
          to: target,
          hasMedia,
          asVoice,
        });
      }

      const log = getLogger();
      const config = getConfig(cfg, accountId ?? undefined);

      if (hasMedia && mediaInput) {
        const conversationId = resolveConversationIdFromSessionKey(sessionKey) ?? target;
        const expectedCardOwnerId =
          readStringParam(params, "expectedCardOwnerId") ?? inferCardOwnerIdFromTarget(target);
        const result = await sendMedia(config, target, mediaInput, {
          log,
          accountId: accountId ?? undefined,
          conversationId,
          mediaType: requestedMediaType ?? undefined,
          audioAsVoice: asVoice,
          mediaLocalRoots: mediaLocalRoots ? [...mediaLocalRoots] : undefined,
          expectedCardOwnerId: expectedCardOwnerId ?? undefined,
        });

        if (!result.ok) {
          throw new Error(result.error || "send media failed");
        }

        return jsonResult({
          ok: true,
          to: target,
          messageId: result.messageId ?? null,
          result: result.data ?? null,
        });
      }

      if (asVoice) {
        throw new Error(
          "DingTalk send with asVoice requires media/path/filePath/mediaUrl pointing to an audio file.",
        );
      }

      if (!message.trim()) {
        throw new Error("send requires message when media is not provided");
      }

      const result = await sendMessage(config, target, message, {
        log,
        accountId: accountId ?? undefined,
      });

      if (!result.ok) {
        throw new Error(result.error || "send message failed");
      }

      const data = result.data as any;
      return jsonResult({
        ok: true,
        to: target,
        messageId: data?.processQueryKey || data?.messageId || null,
        result: data ?? null,
      });
    },
  };
}
