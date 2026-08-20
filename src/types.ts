/**
 * Type definitions for DingTalk Channel Plugin
 *
 * Provides comprehensive type safety for:
 * - Configuration objects
 * - DingTalk API request/response models
 * - Message content and formats
 * - Media files and streams
 * - Session and token management
 */

import type {
  ChannelAccountSnapshot as SDKChannelAccountSnapshot,
  ChannelGatewayContext as SDKChannelGatewayContext,
  ChannelLogSink as SDKChannelLogSink,
} from "openclaw/plugin-sdk/channel-contract";
import type { ChannelPlugin as SDKChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import type { SecretInput } from "./secret-input";

export type AckReactionMode = "off" | "emoji" | "kaomoji";
// Accept arbitrary strings for backward compatibility; the recommended
// explicit modes remain: "off" | "emoji" | "kaomoji".
export type AckReactionConfigValue = string;
export type CardStreamingMode = "off" | "answer" | "all";
export type ContextVisibilityMode = "all" | "allowlist" | "allowlist_quote";

/**
 * DingTalk channel configuration (extends base OpenClaw config)
 */
export interface DingTalkConfig extends OpenClawConfig {
  clientId: string;
  clientSecret: SecretInput;
  name?: string;
  enabled?: boolean;
  dmPolicy?: "open" | "pairing" | "allowlist";
  groupPolicy?: "open" | "allowlist" | "disabled";
  allowFrom?: string[];
  groupAllowFrom?: string[];
  displayNameResolution?: "disabled" | "all";
  contextVisibility?: ContextVisibilityMode;
  mediaUrlAllowlist?: string[];
  journalTTLDays?: number;
  ackReaction?: AckReactionConfigValue;
  debug?: boolean;
  messageType?: "markdown" | "card";
  /** @deprecated 已固定使用内置模板契约 */
  cardTemplateId?: string;
  /** @deprecated 已固定使用内置模板契约 */
  cardTemplateKey?: string;
  groups?: Record<
    string,
    { systemPrompt?: string; requireMention?: boolean; groupAllowFrom?: string[] }
  >;
  accounts?: Record<string, DingTalkConfig>;
  // Connection robustness configuration
  maxConnectionAttempts?: number;
  initialReconnectDelay?: number;
  maxReconnectDelay?: number;
  reconnectJitter?: number;
  /** Maximum number of runtime reconnect cycles before giving up (default: 10) */
  maxReconnectCycles?: number;
  /** Maximum time (ms) for a single reconnect cycle before giving up and starting a new cycle (default: 50000) */
  reconnectDeadlineMs?: number;
  /** Whether to use ConnectionManager; when false, use DWClient native keepAlive+autoReconnect */
  useConnectionManager?: boolean;
  /** Maximum inbound media file size in MB (overrides runtime default when set) */
  mediaMaxMb?: number;
  /** Whether to enable underlying stream keepAlive heartbeat; defaults to !useConnectionManager when omitted */
  keepAlive?: boolean;
  /** Bypass system/global HTTP(S) proxy for DingTalk outbound send/card/upload APIs */
  bypassProxyForSend?: boolean;
  proactivePermissionHint?: {
    enabled?: boolean;
    cooldownHours?: number;
  };
  /** Card streaming mode.
   *  - off: disable incremental streaming
   *  - answer: stream answer text
   *  - all: stream answer + reasoning text */
  cardStreamingMode?: CardStreamingMode;
  /** @deprecated Use `cardStreamingMode` instead. */
  cardRealTimeStream?: boolean;
  /** Throttle interval in ms for card stream updates (default 1000) */
  cardStreamInterval?: number;
  /** AICard degrade duration in milliseconds after trigger errors (default 30m) */
  aicardDegradeMs?: number;
  /** Enable local learning loop (events/reflections/session notes/global rules) */
  learningEnabled?: boolean;
  /** Auto-apply generated reflections into session notes/global rules (default false) */
  learningAutoApply?: boolean;
  /** Session learning note TTL in milliseconds (default 6h) */
  learningNoteTtlMs?: number;
  /** Whether to convert markdown tables to plain text for better rendering on some clients (default: true) */
  convertMarkdownTables?: boolean;
  /** @mention the sender after card finalization in group chats; value is the message text */
  cardAtSender?: string;
  /** Status line visibility toggles for the AI card footer */
  cardStatusLine?: {
    model?: boolean;
    effort?: boolean;
    agent?: boolean;
    taskTime?: boolean;
    tokens?: boolean;
    dapiUsage?: boolean;
  };
}

/**
 * Multi-account DingTalk configuration wrapper
 */
export interface DingTalkChannelConfig {
  enabled?: boolean;
  clientId: string;
  clientSecret: SecretInput;
  name?: string;
  dmPolicy?: "open" | "pairing" | "allowlist";
  groupPolicy?: "open" | "allowlist" | "disabled";
  allowFrom?: string[];
  groupAllowFrom?: string[];
  displayNameResolution?: "disabled" | "all";
  contextVisibility?: ContextVisibilityMode;
  mediaUrlAllowlist?: string[];
  journalTTLDays?: number;
  ackReaction?: AckReactionConfigValue;
  debug?: boolean;
  messageType?: "markdown" | "card";
  /** @deprecated 已固定使用内置模板契约 */
  cardTemplateId?: string;
  /** @deprecated 已固定使用内置模板契约 */
  cardTemplateKey?: string;
  groups?: Record<
    string,
    { systemPrompt?: string; requireMention?: boolean; groupAllowFrom?: string[] }
  >;
  accounts?: Record<string, DingTalkConfig>;
  maxConnectionAttempts?: number;
  initialReconnectDelay?: number;
  maxReconnectDelay?: number;
  reconnectJitter?: number;
  /** Maximum number of runtime reconnect cycles before giving up (default: 10) */
  maxReconnectCycles?: number;
  /** Maximum time (ms) for a single reconnect cycle before giving up and starting a new cycle (default: 50000) */
  reconnectDeadlineMs?: number;
  /** Whether to use ConnectionManager; when false, use DWClient native keepAlive+autoReconnect */
  useConnectionManager?: boolean;
  /** Maximum inbound media file size in MB (overrides runtime default when set) */
  mediaMaxMb?: number;
  /** Whether to enable underlying stream keepAlive heartbeat; defaults to !useConnectionManager when omitted */
  keepAlive?: boolean;
  /** Bypass system/global HTTP(S) proxy for DingTalk outbound send/card/upload APIs */
  bypassProxyForSend?: boolean;
  proactivePermissionHint?: {
    enabled?: boolean;
    cooldownHours?: number;
  };
  /** Card streaming mode.
   *  - off: disable incremental streaming
   *  - answer: stream answer text
   *  - all: stream answer + reasoning text */
  cardStreamingMode?: CardStreamingMode;
  /** @deprecated Use `cardStreamingMode` instead. */
  cardRealTimeStream?: boolean;
  /** Throttle interval in ms for card stream updates (default 1000) */
  cardStreamInterval?: number;
  /** AICard degrade duration in milliseconds after trigger errors (default 30m) */
  aicardDegradeMs?: number;
  /** Enable local learning loop (events/reflections/session notes/global rules) */
  learningEnabled?: boolean;
  /** Auto-apply generated reflections into session notes/global rules (default false) */
  learningAutoApply?: boolean;
  /** Session learning note TTL in milliseconds (default 6h) */
  learningNoteTtlMs?: number;
  /** Whether to convert markdown tables to plain text for better rendering on some clients (default: true) */
  convertMarkdownTables?: boolean;
  /** @mention the sender after card finalization in group chats; value is the message text */
  cardAtSender?: string;
}

/**
 * DingTalk token info for caching
 */
export interface TokenInfo {
  accessToken: string;
  expireIn: number;
}

/**
 * DingTalk API token response
 */
export interface TokenResponse {
  accessToken: string;
  expireIn: number;
}

/**
 * DingTalk API generic response wrapper
 */
export interface DingTalkApiResponse<T = unknown> {
  data?: T;
  code?: string;
  message?: string;
  success?: boolean;
}

/**
 * Media download response from DingTalk API
 */
export interface MediaDownloadResponse {
  downloadUrl?: string;
  downloadCode?: string;
}

/**
 * Media file metadata
 */
export interface MediaFile {
  path: string;
  mimeType: string;
}

export interface DocInfo {
  docId: string;
  title: string;
  docType: string;
  creatorId?: string;
  updatedAt?: number | string;
}

/**
 * DingTalk incoming message (Stream mode)
 */
export interface DingTalkInboundMessage {
  msgId: string;
  msgtype: string;
  createAt: number;
  /**
   * @ 提及的用户列表（消息顶层，与 text 同级）
   * 包含通过 @picker 选中的所有真实钉钉用户和机器人
   * 格式: [{ dingtalkId: "$:LWCP_v1:$xxx" }]
   */
  atUsers?: Array<{
    dingtalkId: string;
  }>;
  text?: {
    content: string;
    isReplyMsg?: boolean; // 是否是回复消息
    repliedMsg?: {
      msgType?: string;
      msgId?: string;
      senderId?: string;
      createdAt?: number;
      content?: {
        text?: string;
        downloadCode?: string;
        fileName?: string;
        biz_custom_action_url?: string;
        richText?: Array<{
          msgType?: string;
          type?: string;
          content?: string;
          text?: string;
          code?: string;
          atName?: string;
          downloadCode?: string;
        }>;
        /** chatRecord 消息摘要 */
        summary?: string;
        /** chatRecord 消息标题 */
        title?: string;
      };
    };
  };
  content?: {
    downloadCode?: string;
    fileName?: string;
    recognition?: string;
    spaceId?: string;
    fileId?: string;
    text?: string;
    title?: string;
    biz_custom_action_url?: string;
    richText?: Array<{
      type: string;
      text?: string;
      atName?: string;
      atUserId?: string;
      downloadCode?: string;
    }>;
    quoteContent?: string;
  };
  // Legacy 引用格式
  quoteMessage?: {
    msgId?: string;
    msgtype?: string;
    text?: { content: string };
    senderNick?: string;
    senderId?: string;
  };
  // 富媒体引用，仅有消息ID的情况（包括手机端和PC端）
  originalMsgId?: string;
  originalProcessQueryKey?: string;
  conversationType: string;
  conversationId: string;
  conversationTitle?: string;
  senderId: string;
  senderStaffId?: string;
  senderNick?: string;
  chatbotUserId: string;
  sessionWebhook: string;
}

export type QuotedRefKey =
  | "msgId"
  | "processQueryKey"
  | "messageId"
  | "outTrackId"
  | "cardInstanceId";

export type AttachmentTextSource = "text" | "html" | "pdf" | "docx";

export interface QuotedRef {
  targetDirection: "inbound" | "outbound";
  key?: QuotedRefKey;
  value?: string;
  fallbackCreatedAt?: number;
}

/**
 * Quoted/reply message metadata extracted from repliedMsg.
 * Populated when isReplyMsg is true; downstream handlers use these fields
 * to download quoted media or look up cached card content.
 */
export interface QuotedInfo {
  mediaDownloadCode?: string;
  mediaType?: string;
  isQuotedFile?: boolean;
  isQuotedCard?: boolean;
  isQuotedDocCard?: boolean;
  cardCreatedAt?: number;
  processQueryKey?: string;
  fileCreatedAt?: number;
  fileDownloadCode?: string;
  msgId?: string;
  previewText?: string;
  previewMessageType?: string;
  previewFileName?: string;
  previewSenderId?: string;
}

/**
 * @ 提及信息
 */
export interface AtMention {
  /** @ 显示的名字（去除 @ 前缀） */
  name: string;
  /** 钉钉用户 ID（如果是 @ 真人） */
  userId?: string;
}

/**
 * Agent 名字匹配结果
 */
export interface AgentNameMatch {
  /** 匹配到的 agent ID */
  agentId: string;
  /** 匹配来源：'name' | 'id' */
  matchSource: "name" | "id";
  /** 匹配到的名字 */
  matchedName: string;
}

/**
 * Extracted message content for unified processing
 */
export interface MessageContent {
  text: string;
  mediaPath?: string;
  mediaPaths?: string[];
  mediaType?: string;
  mediaTypes?: string[];
  messageType: string;
  docSpaceId?: string;
  docFileId?: string;
  quoted?: QuotedInfo;
  /** @ 提及列表（从文本或 richText 提取的名字） */
  atMentions?: AtMention[];
  /**
   * 通过 @picker 选中的真实钉钉用户的 dingtalkId 列表
   * - 仅包含真实钉钉用户和机器人，不包含 agent 名
   * - 用于排除真人：如果 atMentions 中的名字匹配到 agent，说明是 agent；
   *   如果没匹配到 agent 且有 atUserDingtalkIds，则可能是真人
   * - 注意：无法将 dingtalkId 映射到具体名字，因为 webhook 不提供此映射
   */
  atUserDingtalkIds?: string[];
}

/**
 * Send message options
 */
export interface SendMessageOptions {
  title?: string;
  useMarkdown?: boolean;
  atUserId?: string | null;
  log?: Logger;
  conversationId?: string;
  mediaPath?: string;
  filePath?: string;
  mediaUrl?: string;
  mediaType?: "image" | "voice" | "video" | "file";
  accountId?: string;
  storePath?: string;
  cardUpdateMode?: "append";
  quotedRef?: QuotedRef;
  /** Force markdown/text delivery even when messageType is "card". Bypasses card
   *  creation while preserving journal writes and other side-effects. */
  forceMarkdown?: boolean;
  /** Allowed local roots for sandbox/container media path resolution. */
  mediaLocalRoots?: string[];
}

export interface DingTalkTrackingMetadata {
  processQueryKey?: string;
  outTrackId?: string;
  cardInstanceId?: string;
}

/**
 * Session webhook response
 */
export interface SessionWebhookResponse {
  msgtype: string;
  markdown?: {
    title: string;
    text: string;
  };
  text?: {
    content: string;
  };
  at?: {
    atUserIds: string[];
    isAtAll: boolean;
  };
}

/**
 * Sub-agent routing options for parameterized message handling
 */
export interface SubAgentOptions {
  /** The agent ID to route to */
  agentId: string;
  /** Prefix to add to response messages (e.g., "[AgentName] ") */
  responsePrefix: string;
  /** The matched agent name */
  matchedName: string;
  /**
   * When set, this dispatch is a targeted slash command (`@agent /new`).
   * The value is the command text with the leading `@mention` stripped, used
   * as `CommandBody` so the framework command layer can recognize it. Content
   * sub-agent dispatches leave this undefined.
   */
  commandText?: string;
}

/**
 * A trusted route resolved by the plugin before recursive or synthetic inbound handling.
 * It is runtime-only and must never be populated from DingTalk callback payload fields.
 */
export interface ResolvedDingTalkRoute {
  agentId: string;
  sessionKey: string;
  mainSessionKey: string;
}

/**
 * Message handler parameters
 */
export interface HandleDingTalkMessageParams {
  cfg: OpenClawConfig;
  accountId: string;
  data: DingTalkInboundMessage;
  sessionWebhook: string;
  log?: Logger;
  dingtalkConfig: DingTalkConfig;
  /** Distinguishes real Stream messages from Ask User callback reinjection. */
  inboundOrigin?: "stream" | "ask-user";
  /**
   * Explicitly enables handler-owned queueing for a real gateway Stream
   * callback. Direct/synthetic callers must not be inferred from raw message
   * shape, because they may already be inside another handler lifecycle.
   */
  inboundQueueEligible?: boolean;
  /** Reuses an already-resolved trusted route for recursive or synthetic handling. */
  routeOverride?: ResolvedDingTalkRoute;
  /**
   * When set, routes message to the specified sub-agent instead of main agent.
   * This enables reuse of the main message handling logic for sub-agents.
   */
  subAgentOptions?: SubAgentOptions;
  /**
   * Pre-downloaded media for sub-agent calls.
   * When set, skips media download to avoid duplication in recursive calls.
   */
  preDownloadedMedia?: {
    mediaPath?: string;
    mediaType?: string;
    mediaPaths?: string[];
    mediaTypes?: string[];
  };
  /**
   * A pre-created AI Card to reuse instead of creating a new one. Set by the
   * inbound session-queue dispatcher when a message was queued behind an active
   * run: the card was already created and is showing a "已排队" acknowledgement,
   * so the handler streams the real reply INTO this same card (in-place update)
   * rather than spawning a second card. When unset, the handler creates a fresh
   * card as usual.
   */
  preCreatedCard?: AICardInstance;
  /**
   * Internal recursion guard for the authorized inbound session queue. The
   * first handler pass performs access control and trusted route resolution;
   * the queued continuation re-enters with this set so it can consume the
   * pre-created card without queueing itself again.
   */
  inboundQueueHandled?: boolean;
}

/**
 * Proactive message payload
 */
export interface ProactiveMessagePayload {
  robotCode: string;
  msgKey: string;
  msgParam: string;
  openConversationId?: string;
  userIds?: string[];
}

/**
 * Account descriptor
 */
export interface AccountDescriptor {
  accountId: string;
  config?: DingTalkConfig;
  enabled?: boolean;
  name?: string;
  configured?: boolean;
}

/**
 * Account resolver result
 */
export interface ResolvedAccount {
  accountId: string;
  config: DingTalkConfig;
  enabled: boolean;
}

/**
 * HTTP request config for axios
 */
export interface AxiosRequestConfig {
  url?: string;
  method?: string;
  data?: unknown;
  headers?: Record<string, string>;
  responseType?: "arraybuffer" | "json" | "text";
}

/**
 * HTTP response from axios
 */
export interface AxiosResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

/**
 * DingTalk Stream callback listener types
 */
export interface StreamCallbackResponse {
  headers?: {
    messageId?: string;
  };
  data: string;
}

/**
 * Reply dispatcher context
 */
export interface ReplyDispatchContext {
  responsePrefix?: string;
  deliver: (payload: unknown) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Reply dispatcher result
 */
export interface ReplyDispatcherResult {
  dispatcher: unknown;
  replyOptions: unknown;
  markDispatchIdle: () => void;
}

/**
 * Retry options
 */
export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  log?: Logger;
}

/**
 * Channel log sink
 */
export type ChannelLogSink = SDKChannelLogSink;

/**
 * @deprecated Use ChannelLogSink instead
 */
export type Logger = ChannelLogSink;

/**
 * Channel account snapshot
 */
export type ChannelAccountSnapshot = SDKChannelAccountSnapshot;

/**
 * @deprecated Use ChannelAccountSnapshot instead
 */
export type ChannelSnapshot = ChannelAccountSnapshot;

/**
 * Plugin gateway start context
 */
export type GatewayStartContext = SDKChannelGatewayContext<ResolvedAccount>;

/**
 * Plugin gateway account stop result
 */
export interface GatewayStopResult {
  stop: () => void;
}

/**
 * DingTalk channel plugin definition
 */
export type DingTalkChannelPlugin = SDKChannelPlugin<ResolvedAccount & { configured: boolean }> & {
  setupWizard?: ChannelSetupWizard;
};

/**
 * Result of target resolution validation
 */
export interface TargetResolutionResult {
  ok: boolean;
  to?: string;
  error?: Error;
}

/**
 * Parameters for resolveTarget validation
 */
export interface ResolveTargetParams {
  to?: string | null;
  [key: string]: unknown;
}

/**
 * Parameters for sendText delivery
 */
export interface SendTextParams {
  cfg: DingTalkConfig;
  to: string;
  text: string;
  accountId?: string;
  [key: string]: unknown;
}

/**
 * Parameters for sendMedia delivery
 */
export interface SendMediaParams {
  cfg: DingTalkConfig;
  to: string;
  mediaPath: string;
  accountId?: string;
  [key: string]: unknown;
}

/**
 * DingTalk outbound handler configuration
 */
export interface DingTalkOutboundHandler {
  deliveryMode: "direct" | "queued" | "batch";
  resolveTarget: (params: ResolveTargetParams) => TargetResolutionResult;
  sendText: (params: SendTextParams) => Promise<{ ok: boolean; data?: unknown; error?: unknown }>;
  sendMedia?: (
    params: SendMediaParams,
  ) => Promise<{ ok: boolean; data?: unknown; error?: unknown }>;
}

/**
 * AI Card status constants
 */
export const AICardStatus = {
  PROCESSING: "1",
  INPUTING: "2",
  FINISHED: "3",
  STOPPED: "4",
  FAILED: "5",
} as const;

/**
 * AI Card state type
 */
export type AICardState = (typeof AICardStatus)[keyof typeof AICardStatus];

/**
 * AI Card instance
 */
export interface AICardInstance {
  cardInstanceId: string;
  processQueryKey?: string;
  accessToken: string;
  conversationId: string;
  contextConversationId?: string;
  accountId?: string;
  storePath?: string;
  createdAt: number;
  lastUpdated: number;
  state: AICardState; // Current card state: PROCESSING, INPUTING, FINISHED, STOPPED, FAILED
  config?: DingTalkConfig; // Store config reference for token refresh
  lastStreamedContent?: string; // Latest copy/content text shown to user
  lastBlockListJson?: string; // Latest rendered CardBlock[] JSON for V2 instances API
  outTrackId?: string;
  /** Cumulative DingTalk API call count for this card instance. */
  dapiUsage?: number;
  /** True after this card has successfully opened DingTalk's streaming lifecycle. */
  streamLifecycleOpened?: boolean;
}

/**
 * AI Card streaming update request (new API)
 */
export interface AICardStreamingRequest {
  outTrackId: string;
  guid: string;
  key: string;
  content: string;
  isFull: boolean;
  isFinalize: boolean;
  isError: boolean;
}

/**
 * Connection state enum for lifecycle management
 */
export enum ConnectionState {
  DISCONNECTED = "DISCONNECTED",
  CONNECTING = "CONNECTING",
  CONNECTED = "CONNECTED",
  DISCONNECTING = "DISCONNECTING",
  FAILED = "FAILED",
}

/**
 * Factory function that creates a fresh DWClient with callback listeners
 * already registered. Used by ConnectionManager to create a new client
 * on reconnection so the new WebSocket can start receiving messages
 * while the old zombie socket is still being cleaned up.
 */
export type StreamClientFactory = () => import("dingtalk-stream").DWClient;

/**
 * Connection manager configuration
 */
export interface ConnectionManagerConfig {
  maxAttempts: number;
  initialDelay: number;
  maxDelay: number;
  jitter: number;
  /** Maximum number of runtime reconnect cycles before giving up (default: 10) */
  maxReconnectCycles?: number;
  /** Maximum time (ms) for a single reconnect cycle before giving up and starting a new cycle (default: 50000) */
  reconnectDeadlineMs?: number;
  /** Callback invoked when connection state changes */
  onStateChange?: (state: ConnectionState, error?: string) => void;
}

/**
 * Connection attempt result
 */
export interface ConnectionAttemptResult {
  success: boolean;
  attempt: number;
  error?: Error;
  nextDelay?: number;
}
/**
 * CardBlock types for AI Card v2 blockList.
 * - 0 = answer (markdown text)
 * - 1 = thinking process
 * - 2 = tool result
 * - 3 = image (uploaded mediaId)
 */
export type CardBlock =
  | { type: 0; markdown: string }
  | { type: 1; markdown: string }
  | { type: 2; markdown: string }
  | { type: 3; mediaId: string; text?: string };
