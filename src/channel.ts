import { buildJsonChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import pluginManifest from "../openclaw.plugin.json";
import { getConfig, isConfigured, mergeAccountWithDefaults, resolveGroupConfig } from "./config";
import {
  CHANNEL_INFLIGHT_NAMESPACE_POLICY,
  createDingTalkGateway,
} from "./gateway/channel-gateway";
import { dingtalkSetupAdapter, dingtalkSetupWizard } from "./onboarding.js";
import { createDingTalkMessageActions } from "./messaging/channel-actions";
import { createDingTalkOutbound } from "./messaging/channel-outbound";
import { createDingTalkStatus } from "./platform/channel-status";
import { hasConfiguredSecretInput } from "./secret-input";
import {
  listDingTalkDirectoryGroups,
  listDingTalkDirectoryUsers,
} from "./targeting/target-directory-adapter";
import { looksLikeDingTalkTargetId, normalizeDingTalkTarget } from "./targeting/target-input";
import type { DingTalkChannelPlugin, ResolvedAccount } from "./types";

// DingTalk Channel Definition (assembly layer).
// Heavy logic is delegated to service modules for maintainability.
export const dingtalkPlugin: DingTalkChannelPlugin = {
  id: "dingtalk",
  meta: {
    id: "dingtalk",
    label: "DingTalk",
    selectionLabel: "DingTalk (钉钉)",
    docsPath: "https://github.com/soimy/openclaw-channel-dingtalk",
    blurb: "钉钉企业内部机器人，使用 Stream 模式，无需公网 IP。",
    aliases: ["dd", "ding"],
  },
  configSchema: buildJsonChannelConfigSchema(pluginManifest.channelConfigs.dingtalk.schema),
  setup: dingtalkSetupAdapter,
  setupWizard: dingtalkSetupWizard,
  capabilities: {
    chatTypes: ["direct", "group"] as Array<"direct" | "group">,
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.dingtalk"] },
  config: {
    listAccountIds: (cfg: OpenClawConfig): string[] => {
      const config = getConfig(cfg);
      return config.accounts && Object.keys(config.accounts).length > 0
        ? Object.keys(config.accounts)
        : isConfigured(cfg)
          ? ["default"]
          : [];
    },
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => {
      const config = getConfig(cfg);
      const id = accountId || "default";
      const account = config.accounts?.[id];
      const resolvedConfig = account ? mergeAccountWithDefaults(config, account) : config;
      const configured = Boolean(
        resolvedConfig.clientId && hasConfiguredSecretInput(resolvedConfig.clientSecret),
      );
      return {
        accountId: id,
        config: resolvedConfig,
        enabled: resolvedConfig.enabled !== false,
        configured,
        name: resolvedConfig.name || null,
      };
    },
    defaultAccountId: (): string => "default",
    isConfigured: (account: ResolvedAccount): boolean =>
      Boolean(account.config?.clientId && hasConfiguredSecretInput(account.config?.clientSecret)),
    describeAccount: (account: ResolvedAccount) => ({
      accountId: account.accountId,
      name: account.config?.name || "DingTalk",
      enabled: account.enabled,
      configured: Boolean(account.config?.clientId),
    }),
  },
  security: {
    resolveDmPolicy: ({ account }: any) => ({
      policy: account.config?.dmPolicy || "open",
      allowFrom: account.config?.allowFrom || [],
      policyPath: "channels.dingtalk.dmPolicy",
      allowFromPath: "channels.dingtalk.allowFrom",
      approveHint: "使用 /allow dingtalk:<userId> 批准用户",
      normalizeEntry: (raw: string) => raw.replace(/^(dingtalk|dd|ding):/i, ""),
    }),
  },
  groups: {
    resolveRequireMention: ({ cfg, groupId }: any): boolean => {
      const config = getConfig(cfg);
      if (groupId) {
        const groupCfg = resolveGroupConfig(config, groupId);
        if (groupCfg?.requireMention !== undefined) {
          return groupCfg.requireMention;
        }
      }
      return config.groupPolicy !== "open";
    },
    resolveGroupIntroHint: ({ groupId, groupChannel }: any): string | undefined => {
      const parts = [`conversationId=${groupId}`];
      if (groupChannel) {
        parts.push(`sessionKey=${groupChannel}`);
      }
      return `DingTalk IDs: ${parts.join(", ")}.`;
    },
  },
  messaging: {
    normalizeTarget: (raw: string) => (raw ? normalizeDingTalkTarget(raw) : undefined),
    targetResolver: {
      looksLikeId: (raw: string, normalized?: string): boolean =>
        looksLikeDingTalkTargetId(raw, normalized),
      hint: "<displayName|conversationId|user:staffId|user:+861...>",
    },
  },
  directory: {
    self: async () => null,
    listGroups: async (params) => listDingTalkDirectoryGroups(params),
    listGroupsLive: async (params) => listDingTalkDirectoryGroups(params),
    listPeers: async (params) => listDingTalkDirectoryUsers(params),
    listPeersLive: async (params) => listDingTalkDirectoryUsers(params),
  },
  actions: createDingTalkMessageActions(),
  outbound: createDingTalkOutbound(),
  gateway: createDingTalkGateway(),
  status: createDingTalkStatus(),
};

export { CHANNEL_INFLIGHT_NAMESPACE_POLICY };
export { getAccessToken } from "./auth";
export { createAICard, finishAICard, streamAICard } from "./card-service";
export { detectMediaTypeFromExtension } from "./media-utils";
export { getLogger } from "./logger-context";
export {
  sendBySession,
  sendMessage,
  sendProactiveMedia,
  uploadMedia,
} from "./send-service";
