import { DWClient, TOPIC_CARD, TOPIC_ROBOT } from "dingtalk-stream";
import { analyzeCardCallback } from "../card-callback-service";
import { finalizeActiveCardsForAccount, recoverPendingCardsForAccount } from "../card-service";
import { recoverAskUserQuestionsForAccount } from "../card/ask-user-question";
import { handleCardAction } from "../card/card-action-handler";
import { resolveRobotCode, resolveRuntimeConfig } from "../config";
import { ConnectionManager } from "../connection-manager";
import { isMessageProcessed, markMessageProcessed } from "../dedup";
import {
  isLearningAutoApplyEnabled,
  isLearningEnabled,
  recordExplicitFeedbackLearning,
} from "../feedback-learning-service";
import { handleDingTalkMessage } from "../inbound-handler";
import { setCurrentLogger } from "../logger-context";
import { preloadPeerIdsFromSessions } from "../peer-id-registry";
import { getDingTalkRuntime } from "../runtime";
import { sendProactiveTextOrMarkdown } from "../send-service";
import type {
  ConnectionManagerConfig,
  DingTalkChannelPlugin,
  DingTalkInboundMessage,
  GatewayStartContext,
  GatewayStopResult,
  StreamClientFactory,
} from "../types";
import { ConnectionState } from "../types";
import {
  closePluginDebugLog,
  cleanupOrphanedTempFiles,
  createResolve4FallbackLookup,
  formatDingTalkConnectionErrorLog,
  getCurrentTimestamp,
  resolvePluginDebugLog,
} from "../utils";

type InstrumentedDWClient = {
  getEndpoint?: () => Promise<unknown>;
  _connect?: () => Promise<unknown>;
  config?: Record<string, unknown> & { endpoint?: { endpoint?: string } | string };
  dw_url?: string;
};

function attachConnectionErrorContext(
  err: unknown,
  stage: "connect.open" | "connect.websocket",
  endpoint?: string,
): void {
  if (!err || typeof err !== "object") {
    return;
  }
  const target = err as Record<string, unknown>;
  if (typeof target.dingtalkConnectionStage !== "string") {
    target.dingtalkConnectionStage = stage;
  }
  if (endpoint && typeof target.dingtalkConnectionEndpoint !== "string") {
    target.dingtalkConnectionEndpoint = endpoint;
  }
}

function getInstrumentedEndpoint(client: InstrumentedDWClient): string | undefined {
  if (typeof client.dw_url === "string" && client.dw_url.length > 0) {
    return client.dw_url;
  }

  const endpointConfig = client.config?.endpoint;
  if (typeof endpointConfig === "string") {
    return endpointConfig;
  }
  if (
    endpointConfig &&
    typeof endpointConfig === "object" &&
    typeof endpointConfig.endpoint === "string"
  ) {
    return endpointConfig.endpoint;
  }
  return undefined;
}

function instrumentConnectionStages(client: DWClient): void {
  const instrumented = client as unknown as InstrumentedDWClient;
  if (
    typeof instrumented.getEndpoint !== "function" ||
    typeof instrumented._connect !== "function"
  ) {
    return;
  }

  const originalGetEndpoint = instrumented.getEndpoint.bind(instrumented);
  const originalSocketConnect = instrumented._connect.bind(instrumented);

  instrumented.getEndpoint = async () => {
    try {
      return await originalGetEndpoint();
    } catch (err) {
      attachConnectionErrorContext(err, "connect.open");
      throw err;
    }
  };

  instrumented._connect = async () => {
    try {
      return await originalSocketConnect();
    } catch (err) {
      attachConnectionErrorContext(err, "connect.websocket", getInstrumentedEndpoint(instrumented));
      throw err;
    }
  };
}

// In-flight dedup keys are released ONLY by the `finally` block after
// `handleDingTalkMessage` settles. There is intentionally NO time-based TTL:
// the inbound session queue may hold a message for up to
// `MAX_INBOUND_SESSION_QUEUE_WAIT_MS` (15 minutes), which is longer than the
// previous 5-minute TTL. Releasing the lock by wall clock while the queued
// message is still pending let DingTalk retries enter a SECOND in-flight
// record, and both copies eventually executed — duplicating external side
// effects. A hung handler now permanently holds its msgId (acceptable: the
// user-visible symptom is "this message isn't being processed" and recovery
// is a process restart, not silent duplicate execution).
const processingDedupKeys = new Map<string, number>();
export const CHANNEL_INFLIGHT_NAMESPACE_POLICY = "memory-only" as const;
const inboundCountersByAccount = new Map<
  string,
  {
    received: number;
    acked: number;
    dedupSkipped: number;
    inflightSkipped: number;
    processed: number;
    failed: number;
    noMessageId: number;
  }
>();
const INBOUND_COUNTER_LOG_EVERY = 10;

function getInboundCounters(accountId: string) {
  const existing = inboundCountersByAccount.get(accountId);
  if (existing) {
    return existing;
  }
  const created = {
    received: 0,
    acked: 0,
    dedupSkipped: 0,
    inflightSkipped: 0,
    processed: 0,
    failed: 0,
    noMessageId: 0,
  };
  inboundCountersByAccount.set(accountId, created);
  return created;
}

function logInboundCounters(log: any, accountId: string, reason: string): void {
  const stats = getInboundCounters(accountId);
  log?.info?.(
    `[${accountId}] Inbound counters (${reason}): received=${stats.received}, acked=${stats.acked}, processed=${stats.processed}, dedupSkipped=${stats.dedupSkipped}, inflightSkipped=${stats.inflightSkipped}, failed=${stats.failed}, noMessageId=${stats.noMessageId}`,
  );
}

export function createDingTalkGateway(): NonNullable<DingTalkChannelPlugin["gateway"]> {
  return {
    startAccount: async (ctx: GatewayStartContext): Promise<GatewayStopResult> => {
      const { account, cfg, abortSignal } = ctx;
      const config = account.config;
      let accountStorePath: string | undefined;
      try {
        const runtime = getDingTalkRuntime();
        accountStorePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
          agentId: account.accountId,
        });
      } catch {
        accountStorePath = undefined;
      }

      const pluginLog = resolvePluginDebugLog({
        accountId: account.accountId,
        storePath: accountStorePath,
        debug: config.debug,
        baseLog: ctx.log,
      });
      // Stream credentials are resolved once per account start. If a file
      // SecretInput rotates, restart the gateway/account so reconnects use the
      // new secret.
      const runtimeConfig = await resolveRuntimeConfig(config, pluginLog);
      setCurrentLogger(pluginLog, account.accountId);

      pluginLog?.info?.(`[${account.accountId}] Initializing DingTalk Stream client...`);

      preloadPeerIdsFromSessions();
      pluginLog?.debug?.(`[${account.accountId}] Peer ID registry preloaded from sessions`);

      cleanupOrphanedTempFiles(pluginLog);
      try {
        const recovered = await recoverPendingCardsForAccount(
          config,
          account.accountId,
          accountStorePath,
          pluginLog,
        );
        if (recovered > 0) {
          pluginLog?.info?.(
            `[${account.accountId}] Recovered and finalized ${recovered} unfinished card(s) from previous runtime`,
          );
        }
      } catch (err: any) {
        pluginLog?.warn?.(
          `[${account.accountId}] Failed to recover unfinished cards: ${err.message}`,
        );
      }
      try {
        const recoveredQuestions = await recoverAskUserQuestionsForAccount({
          storePath: accountStorePath,
          accountId: account.accountId,
          config,
          log: pluginLog,
        });
        if (recoveredQuestions > 0) {
          pluginLog?.info?.(
            `[${account.accountId}] Invalidated ${recoveredQuestions} unfinished Ask User card(s) from previous runtime`,
          );
        }
      } catch (err: any) {
        pluginLog?.warn?.(
          `[${account.accountId}] Failed to recover Ask User cards: ${err.message}`,
        );
      }

      const useConnectionManager = config.useConnectionManager ?? true;
      const applyStatusPatch = (patch: Record<string, unknown>) => {
        ctx.setStatus({
          ...ctx.getStatus(),
          ...patch,
        });
      };

      const createStreamClient: StreamClientFactory = () => {
        const client = new DWClient({
          clientId: runtimeConfig.clientId,
          clientSecret: runtimeConfig.clientSecret,
          debug: runtimeConfig.debug || false,
          keepAlive: runtimeConfig.keepAlive ?? !useConnectionManager,
        });
        (client as any).sslopts = {
          ...(client as any).sslopts,
          lookup: createResolve4FallbackLookup(pluginLog, account.accountId),
        };

        instrumentConnectionStages(client);

        (client as any).config.autoReconnect = !useConnectionManager;

        client.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
          const messageId = res.headers?.messageId;
          const stats = getInboundCounters(account.accountId);
          stats.received += 1;
          const acknowledge = () => {
            if (!messageId) {
              return;
            }
            try {
              client.socketCallBackResponse(messageId, { success: true });
              stats.acked += 1;
            } catch (ackError: any) {
              pluginLog?.warn?.(
                `[${account.accountId}] Failed to acknowledge callback ${messageId}: ${ackError.message}`,
              );
            }
          };
          try {
            const data = JSON.parse(res.data) as DingTalkInboundMessage;
            applyStatusPatch({
              connected: true,
              lastInboundAt: getCurrentTimestamp(),
              lastEventAt: getCurrentTimestamp(),
            });

            const robotKey = resolveRobotCode(config) || account.accountId;
            const msgId = data.msgId || messageId;
            const dedupKey = msgId ? `${robotKey}:${msgId}` : undefined;

            if (!dedupKey) {
              ctx.log?.warn?.(`[${account.accountId}] No message ID available for deduplication`);
              stats.noMessageId += 1;
              acknowledge();
              await handleDingTalkMessage({
                cfg,
                accountId: account.accountId,
                data,
                sessionWebhook: data.sessionWebhook,
                log: pluginLog,
                dingtalkConfig: config,
                inboundOrigin: "stream",
                inboundQueueEligible: true,
              });
              stats.processed += 1;
              if (stats.received % INBOUND_COUNTER_LOG_EVERY === 0) {
                logInboundCounters(pluginLog, account.accountId, "periodic");
              }
              return;
            }

            if (isMessageProcessed(dedupKey)) {
              pluginLog?.debug?.(`[${account.accountId}] Skipping duplicate message: ${dedupKey}`);
              stats.dedupSkipped += 1;
              acknowledge();
              logInboundCounters(pluginLog, account.accountId, "dedup-skipped");
              return;
            }

            // In-flight lock: only the `finally` block below ever releases
            // this key. See `processingDedupKeys` declaration for why we no
            // longer release by time-based TTL.
            if (processingDedupKeys.has(dedupKey)) {
              pluginLog?.debug?.(
                `[${account.accountId}] Skipping in-flight duplicate message: ${dedupKey}`,
              );
              stats.inflightSkipped += 1;
              acknowledge();
              logInboundCounters(pluginLog, account.accountId, "inflight-skipped");
              return;
            }

            acknowledge();
            processingDedupKeys.set(dedupKey, Date.now());
            try {
              await handleDingTalkMessage({
                cfg,
                accountId: account.accountId,
                data,
                sessionWebhook: data.sessionWebhook,
                log: pluginLog,
                dingtalkConfig: config,
                inboundOrigin: "stream",
                inboundQueueEligible: true,
              });
              stats.processed += 1;
              markMessageProcessed(dedupKey);
              if (stats.received % INBOUND_COUNTER_LOG_EVERY === 0) {
                logInboundCounters(pluginLog, account.accountId, "periodic");
              }
            } finally {
              processingDedupKeys.delete(dedupKey);
            }
          } catch (error: any) {
            stats.failed += 1;
            logInboundCounters(pluginLog, account.accountId, "failed");
            pluginLog?.error?.(`[${account.accountId}] Error processing message: ${error.message}`);
          }
        });

        client.registerCallbackListener(TOPIC_CARD, async (res: any) => {
          const messageId = res.headers?.messageId;
          const acknowledge = () => {
            if (!messageId) {
              return;
            }
            try {
              client.socketCallBackResponse(messageId, { success: true });
            } catch (ackError: any) {
              pluginLog?.warn?.(
                `[${account.accountId}] Failed to acknowledge card callback ${messageId}: ${ackError.message}`,
              );
            }
          };

          try {
            const payload = JSON.parse(res.data);
            const analysis = analyzeCardCallback(payload);
            pluginLog?.info?.(
              `[${account.accountId}] [DingTalk][CardCallback] action=${analysis.summary} raw=${JSON.stringify(payload)}`,
            );

            if (analysis.feedbackTarget && analysis.feedbackAckText) {
              recordExplicitFeedbackLearning({
                enabled: isLearningEnabled(config),
                autoApply: isLearningAutoApplyEnabled(config),
                storePath: accountStorePath,
                accountId: account.accountId,
                targetId: analysis.feedbackTarget,
                feedbackType: analysis.actionId === "feedback_up" ? "feedback_up" : "feedback_down",
                userId: analysis.userId,
                processQueryKey: analysis.processQueryKey,
                noteTtlMs: config.learningNoteTtlMs,
              });
              try {
                await sendProactiveTextOrMarkdown(
                  config,
                  analysis.feedbackTarget,
                  analysis.feedbackAckText,
                  {
                    accountId: account.accountId,
                    log: pluginLog,
                  },
                );
                pluginLog?.info?.(
                  `[${account.accountId}] [DingTalk][CardCallback] feedback ack sent to ${analysis.feedbackTarget}`,
                );
              } catch (sendErr: any) {
                pluginLog?.warn?.(
                  `[${account.accountId}] [DingTalk][CardCallback] Failed to send feedback ack: ${sendErr?.message || String(sendErr)}`,
                );
              }
            }
            const actionResult = await handleCardAction({
              payload,
              analysis,
              cfg,
              accountId: account.accountId,
              storePath: accountStorePath,
              config,
              log: pluginLog,
            });
            if (
              !actionResult.handled &&
              analysis.actionId &&
              analysis.actionId !== "feedback_up" &&
              analysis.actionId !== "feedback_down"
            ) {
              pluginLog?.debug?.(
                `[${account.accountId}] [DingTalk][CardCallback] Unhandled actionId=${analysis.actionId}`,
              );
            }
          } catch (error: any) {
            pluginLog?.error?.(
              `[${account.accountId}] [DingTalk][CardCallback] Failed to parse callback: ${error.message}`,
            );
          } finally {
            acknowledge();
          }
        });

        return client;
      };

      const client = createStreamClient();

      let stopped = false;
      let nativeStopResolve: (() => void) | undefined;
      const nativeStopPromise = new Promise<void>((resolve) => {
        nativeStopResolve = resolve;
      });
      let connectionManager: ConnectionManager | undefined;

      const stopClient = () => {
        if (stopped) {
          return;
        }
        stopped = true;
        pluginLog?.info?.(`[${account.accountId}] Stopping DingTalk Stream client...`);
        void finalizeActiveCardsForAccount(
          config,
          account.accountId,
          "⚠️ 服务正在重启，当前回复已中断。请重新发送你的问题。",
          accountStorePath,
          pluginLog,
        ).catch((err: any) => {
          pluginLog?.debug?.(
            `[${account.accountId}] Failed to finalize active cards during stop: ${err.message}`,
          );
        });
        if (useConnectionManager) {
          connectionManager?.stop();
        } else {
          try {
            client.disconnect();
          } catch (err: any) {
            pluginLog?.warn?.(`[${account.accountId}] Error during disconnect: ${err.message}`);
          }
          nativeStopResolve?.();
        }

        applyStatusPatch({
          running: false,
          connected: false,
          lastEventAt: getCurrentTimestamp(),
          lastStopAt: getCurrentTimestamp(),
        });

        pluginLog?.info?.(`[${account.accountId}] DingTalk Stream client stopped`);
        closePluginDebugLog({
          accountId: account.accountId,
          storePath: accountStorePath,
        });
      };

      if (abortSignal) {
        if (abortSignal.aborted) {
          pluginLog?.warn?.(
            `[${account.accountId}] Abort signal already active, skipping connection`,
          );

          applyStatusPatch({
            running: false,
            connected: false,
            lastEventAt: getCurrentTimestamp(),
            lastStopAt: getCurrentTimestamp(),
            lastError: "Connection aborted before start",
          });

          throw new Error("Connection aborted before start");
        }

        abortSignal.addEventListener("abort", () => {
          if (stopped) {
            return;
          }
          pluginLog?.info?.(
            `[${account.accountId}] Abort signal received, stopping DingTalk Stream client...`,
          );
          stopClient();
        });
      }

      if (!useConnectionManager) {
        try {
          await client.connect();
          if (!stopped) {
            applyStatusPatch({
              running: true,
              connected: true,
              lastConnectedAt: getCurrentTimestamp(),
              lastEventAt: getCurrentTimestamp(),
              lastStartAt: getCurrentTimestamp(),
              lastError: null,
            });
            pluginLog?.info?.(
              `[${account.accountId}] DingTalk Stream client connected successfully`,
            );
            await nativeStopPromise;
          }
        } catch (err: any) {
          pluginLog?.error?.(
            formatDingTalkConnectionErrorLog(
              "connect.open",
              err,
              `[${account.accountId}] Failed to establish connection: ${err.message}`,
            ) ?? `[${account.accountId}] Failed to establish connection: ${err.message}`,
          );
          applyStatusPatch({
            running: false,
            connected: false,
            lastEventAt: getCurrentTimestamp(),
            lastError: err.message || "Connection failed",
          });
          throw err;
        }

        return {
          stop: () => {
            stopClient();
          },
        };
      }

      const connectionConfig: ConnectionManagerConfig = {
        maxAttempts: config.maxConnectionAttempts ?? 10,
        initialDelay: config.initialReconnectDelay ?? 1000,
        maxDelay: config.maxReconnectDelay ?? 60000,
        jitter: config.reconnectJitter ?? 0.3,
        maxReconnectCycles: config.maxReconnectCycles,
        reconnectDeadlineMs: config.reconnectDeadlineMs,
        onStateChange: (state: ConnectionState, error?: string) => {
          if (stopped) {
            return;
          }
          pluginLog?.debug?.(
            `[${account.accountId}] Connection state changed to: ${state}${error ? ` (${error})` : ""}`,
          );
          if (state === ConnectionState.CONNECTED) {
            applyStatusPatch({
              running: true,
              connected: true,
              lastConnectedAt: getCurrentTimestamp(),
              lastEventAt: getCurrentTimestamp(),
              lastStartAt: getCurrentTimestamp(),
              lastError: null,
            });
          } else if (state === ConnectionState.FAILED || state === ConnectionState.DISCONNECTED) {
            // Intentionally do NOT clear `processingDedupKeys` here: a stream
            // disconnect must not release in-flight locks for messages whose
            // handler is still executing (or queued behind an active run),
            // because DingTalk will resend on reconnect and a cleared lock
            // would let the resend enter a SECOND handler invocation —
            // duplicating external side effects. Only `finally` after the
            // handler settles releases a key.
            applyStatusPatch({
              running: false,
              connected: false,
              lastEventAt: getCurrentTimestamp(),
              lastError: error || `Connection ${state.toLowerCase()}`,
            });
          }
        },
      };

      pluginLog?.debug?.(
        `[${account.accountId}] Connection config: maxAttempts=${connectionConfig.maxAttempts}, ` +
          `initialDelay=${connectionConfig.initialDelay}ms, maxDelay=${connectionConfig.maxDelay}ms, ` +
          `jitter=${connectionConfig.jitter}`,
      );

      connectionManager = new ConnectionManager(
        client,
        account.accountId,
        connectionConfig,
        pluginLog,
        createStreamClient,
      );

      try {
        await connectionManager.connect();

        if (!stopped && connectionManager.isConnected()) {
          applyStatusPatch({
            running: true,
            connected: true,
            lastConnectedAt: getCurrentTimestamp(),
            lastEventAt: getCurrentTimestamp(),
            lastStartAt: getCurrentTimestamp(),
            lastError: null,
          });
          pluginLog?.info?.(`[${account.accountId}] DingTalk Stream client connected successfully`);

          await connectionManager.waitForStop();
        } else {
          pluginLog?.info?.(
            `[${account.accountId}] DingTalk Stream client connect() completed but channel is ` +
              `not running (stopped=${stopped}, connected=${connectionManager.isConnected()})`,
          );
        }
      } catch (err: any) {
        pluginLog?.error?.(
          formatDingTalkConnectionErrorLog(
            "connect.open",
            err,
            `[${account.accountId}] Failed to establish connection: ${err.message}`,
          ) ?? `[${account.accountId}] Failed to establish connection: ${err.message}`,
        );

        applyStatusPatch({
          running: false,
          connected: false,
          lastEventAt: getCurrentTimestamp(),
          lastError: err.message || "Connection failed",
        });
        throw err;
      }

      return {
        stop: () => {
          stopClient();
        },
      };
    },
  };
}
