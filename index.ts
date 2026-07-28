import {
  defineChannelPluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/core";
import { readStringParam } from "openclaw/plugin-sdk/param-readers";
import { getAccessToken } from "./src/auth";
import { registerDingTalkAskUserQuestionTool } from "./src/card/ask-user-question";
import { dingtalkPlugin } from "./src/channel";
import { getConfig, listDingTalkAccountIds, resolveDingTalkAccount } from "./src/config";
import {
  appendToDoc,
  createDoc,
  DocCreateAppendError,
  listDocs,
  searchDocs,
} from "./src/docs-service";
import { accumulateUsage } from "./src/run-usage-store";
import { setDingTalkRuntime } from "./src/runtime";
import { sendMessage } from "./src/send-service";

type GatewayMethodContext = Pick<
  Parameters<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>[0],
  "context" | "params" | "respond"
>;

/**
 * Register the canonical OpenClaw DingTalk docs RPC namespace.
 *
 * The `dingtalk-connector.docs.*` names below are compatibility aliases for
 * existing connector-style Gateway callers that already use the
 * `dingtalk-connector` prefix. They intentionally share the same handlers as
 * `dingtalk.docs.*`; this plugin does not vendor or mirror a separate
 * third-party connector implementation. New OpenClaw callers should prefer the
 * canonical `dingtalk.docs.*` namespace.
 */
function registerDingTalkDocsGatewayMethods(api: OpenClawPluginApi): void {
  const createHandler = async ({ respond, params }: GatewayMethodContext) => {
    const accountId = readStringParam(params, "accountId");
    const spaceId = readStringParam(params, "spaceId", { required: true });
    const title = readStringParam(params, "title", { required: true });
    const content = readStringParam(params, "content", { allowEmpty: true });
    const parentId = readStringParam(params, "parentId");
    const config = getConfig(api.config, accountId ?? undefined);
    try {
      const doc = await createDoc(
        config,
        spaceId,
        title,
        content ?? undefined,
        api.logger,
        parentId ?? undefined,
      );
      return respond(true, doc);
    } catch (error) {
      if (error instanceof DocCreateAppendError) {
        return respond(true, {
          partialSuccess: true,
          initContentAppended: false,
          docId: error.doc.docId,
          doc: error.doc,
          appendError: error.message,
        });
      }
      throw error;
    }
  };

  const appendHandler = async ({ respond, params }: GatewayMethodContext) => {
    const accountId = readStringParam(params, "accountId");
    const docId = readStringParam(params, "docId", { required: true });
    const content = readStringParam(params, "content", { required: true, allowEmpty: false });
    const config = getConfig(api.config, accountId ?? undefined);
    const result = await appendToDoc(config, docId, content, api.logger);
    return respond(true, result);
  };

  const searchHandler = async ({ respond, params }: GatewayMethodContext) => {
    const accountId = readStringParam(params, "accountId");
    const keyword = readStringParam(params, "keyword", { required: true });
    const spaceId = readStringParam(params, "spaceId");
    const config = getConfig(api.config, accountId ?? undefined);
    const docs = await searchDocs(config, keyword, spaceId, api.logger);
    return respond(true, { docs });
  };

  const listHandler = async ({ respond, params }: GatewayMethodContext) => {
    const accountId = readStringParam(params, "accountId");
    const spaceId = readStringParam(params, "spaceId", { required: true });
    const parentId = readStringParam(params, "parentId");
    const config = getConfig(api.config, accountId ?? undefined);
    const docs = await listDocs(config, spaceId, parentId, api.logger);
    return respond(true, { docs });
  };

  api.registerGatewayMethod("dingtalk.docs.create", createHandler);
  api.registerGatewayMethod("dingtalk.docs.append", appendHandler);
  api.registerGatewayMethod("dingtalk.docs.search", searchHandler);
  api.registerGatewayMethod("dingtalk.docs.list", listHandler);
  api.registerGatewayMethod("dingtalk-connector.docs.create", createHandler);
  api.registerGatewayMethod("dingtalk-connector.docs.append", appendHandler);
  api.registerGatewayMethod("dingtalk-connector.docs.search", searchHandler);
  api.registerGatewayMethod("dingtalk-connector.docs.list", listHandler);
}

function getContentParam(params: Record<string, unknown>): string | undefined {
  return readStringParam(params, "content") ?? readStringParam(params, "message");
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function maskClientId(clientId: string | undefined): string | null {
  if (!clientId) {
    return null;
  }
  return clientId.length <= 4 ? "****" : `****${clientId.slice(-4)}`;
}

function isConnectorSendTarget(target: string): boolean {
  return /^(user|group):\S+$/.test(target);
}

async function sendGatewayMessage(params: {
  api: OpenClawPluginApi;
  respond: GatewayMethodContext["respond"];
  accountId?: string;
  target: string;
  content: string;
  storePath?: string;
  useAICard?: unknown;
}) {
  const config = getConfig(params.api.config, params.accountId);
  const accountId = params.accountId ?? "default";
  if (!config.clientId || !config.clientSecret) {
    return params.respond(false, { error: "DingTalk not configured" });
  }
  let result: Awaited<ReturnType<typeof sendMessage>>;
  try {
    result = await sendMessage(config, params.target, params.content, {
      log: params.api.logger,
      accountId,
      conversationId: params.target,
      storePath: params.storePath,
      forceMarkdown: params.useAICard === false,
    });
  } catch (error: unknown) {
    const message = getErrorMessage(error, "send failed");
    params.api.logger?.warn?.(`[DingTalk][GatewayRPC] send failed: ${message}`);
    return params.respond(false, { error: message });
  }
  return params.respond(
    result.ok,
    result.ok
      ? {
          ok: true,
          target: params.target,
          messageId: result.messageId ?? null,
          tracking: result.tracking ?? null,
        }
      : { error: result.error || "send failed" },
  );
}

/**
 * Register compatibility Gateway RPCs for connector-style DingTalk callers.
 *
 * Compatibility target: callers that address DingTalk through the historical
 * `dingtalk-connector.*` Gateway namespace. The maintenance boundary is only
 * this thin parameter/response adapter; canonical plugin behavior, auth, docs,
 * sending, and persistence remain implemented by this repository's existing
 * `dingtalk.*` services. Do not add connector-only behavior here unless it is
 * also documented as part of this compatibility surface.
 */
function registerDingTalkConnectorCompatibilityGatewayMethods(api: OpenClawPluginApi): void {
  api.registerGatewayMethod(
    "dingtalk-connector.sendToUser",
    async ({ context, respond, params }: GatewayMethodContext) => {
      const accountId = readStringParam(params, "accountId");
      const userId = readStringParam(params, "userId", { required: true });
      const content = getContentParam(params);
      if (!content) {
        return respond(false, { error: "content or message is required" });
      }
      return sendGatewayMessage({
        api,
        respond,
        accountId: accountId ?? undefined,
        target: `user:${userId}`,
        content,
        storePath: context?.cronStorePath,
        useAICard: params.useAICard,
      });
    },
  );

  api.registerGatewayMethod(
    "dingtalk-connector.sendToGroup",
    async ({ context, respond, params }: GatewayMethodContext) => {
      const accountId = readStringParam(params, "accountId");
      const openConversationId = readStringParam(params, "openConversationId", { required: true });
      const content = getContentParam(params);
      if (!content) {
        return respond(false, { error: "content or message is required" });
      }
      return sendGatewayMessage({
        api,
        respond,
        accountId: accountId ?? undefined,
        target: `group:${openConversationId}`,
        content,
        storePath: context?.cronStorePath,
        useAICard: params.useAICard,
      });
    },
  );

  api.registerGatewayMethod(
    "dingtalk-connector.send",
    async ({ context, respond, params }: GatewayMethodContext) => {
      const accountId = readStringParam(params, "accountId");
      const target = readStringParam(params, "target", { required: true });
      const content = getContentParam(params);
      if (!content) {
        return respond(false, { error: "content or message is required" });
      }
      if (!isConnectorSendTarget(target)) {
        return respond(false, { error: "target must start with user: or group:" });
      }
      return sendGatewayMessage({
        api,
        respond,
        accountId: accountId ?? undefined,
        target,
        content,
        storePath: context?.cronStorePath,
        useAICard: params.useAICard,
      });
    },
  );

  api.registerGatewayMethod(
    "dingtalk-connector.status",
    async ({ respond }: GatewayMethodContext) => {
      const accountIds = listDingTalkAccountIds(api.config);
      const accounts = accountIds.length > 0 ? accountIds : ["default"];
      return respond(true, {
        channel: "dingtalk",
        accounts: accounts.map((accountId) => {
          const account = resolveDingTalkAccount(api.config, accountId);
          return {
            accountId,
            configured: account.configured,
            enabled: account.enabled !== false,
            name: account.name ?? null,
            clientId: maskClientId(account.clientId),
          };
        }),
      });
    },
  );

  api.registerGatewayMethod(
    "dingtalk-connector.probe",
    async ({ respond, params }: GatewayMethodContext) => {
      const accountId = readStringParam(params, "accountId");
      const config = getConfig(api.config, accountId ?? undefined);
      if (!config.clientId || !config.clientSecret) {
        return respond(false, { error: "DingTalk not configured" });
      }
      try {
        await getAccessToken(config, api.logger);
        return respond(true, { ok: true, clientId: maskClientId(config.clientId) });
      } catch (error: unknown) {
        const message = getErrorMessage(error, "probe failed");
        api.logger?.warn?.(`[DingTalk][GatewayRPC] probe failed: ${message}`);
        return respond(false, { error: message });
      }
    },
  );
}

export { dingtalkPlugin } from "./src/channel";
export { setDingTalkRuntime } from "./src/runtime";

const dingtalkEntry = defineChannelPluginEntry({
  id: "dingtalk",
  name: "DingTalk Channel",
  description: "DingTalk (钉钉) messaging channel via Stream mode",
  plugin: dingtalkPlugin,
  setRuntime: setDingTalkRuntime,
  registerFull(api) {
    registerDingTalkDocsGatewayMethods(api);
    registerDingTalkConnectorCompatibilityGatewayMethods(api);
    registerDingTalkAskUserQuestionTool(api);

    api.on(
      "llm_output",
      (event: {
        runId: string;
        usage?: {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
          total?: number;
        };
      }) => {
        if (event.usage) {
          accumulateUsage(event.runId, event.usage);
        }
      },
    );
  },
});

const pluginDefinition: OpenClawPluginDefinition = {
  ...dingtalkEntry,
  register(api: OpenClawPluginApi) {
    const registrationMode = api.registrationMode as string | undefined;
    if (registrationMode === "tool-discovery") {
      registerDingTalkAskUserQuestionTool(api);
      return;
    }
    if (registrationMode === "discovery") {
      registerDingTalkAskUserQuestionTool(api);
    }
    dingtalkEntry.register(api);
  },
};

export default pluginDefinition;
