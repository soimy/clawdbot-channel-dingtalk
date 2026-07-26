import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { getAccessToken } from "../auth";
import { updateCardVariables } from "../card-callback-service";
import { resolveRobotCode } from "../config";
import axios from "../http-client";
import { handleDingTalkMessage } from "../inbound-handler";
import type { DingTalkConfig, DingTalkInboundMessage, Logger } from "../types";
import { formatDingTalkErrorPayloadLog, getProxyBypassOption, parseBooleanLike } from "../utils";
import {
  getDingTalkQuestionContext,
  type DingTalkQuestionContext,
} from "./ask-user-question-context";
import {
  activateAskUserQuestion,
  claimAskUserQuestion,
  invalidateAskUserQuestionsInScope as invalidateAskUserQuestionsInStore,
  recoverAskUserQuestionsAfterRestart,
  reserveAskUserQuestion,
  resolveAskUserQuestion,
  terminateAskUserQuestion,
  type AskUserLifecycleRecord,
  type AskUserStoreOptions,
  type AskUserTerminalReason,
} from "./ask-user-question-store";
import { DINGTALK_ASK_USER_CARD_TEMPLATE } from "./card-template";

const DINGTALK_API = "https://api.dingtalk.com";
const PENDING_QUESTION_TTL_MS = 5 * 60 * 1000;
const HANDLED_CALLBACK_TOMBSTONE_TTL_MS = 30 * 60 * 1000;
const TOOL_NAME = "dingtalk_ask_user_question";
const ANSWER_FIELD_PREFIX = "answer";

type AskUserOption = {
  label?: string;
  value?: string;
  description?: string;
};

type AskUserQuestion = {
  question?: string;
  header?: string;
  options?: AskUserOption[];
  multiSelect?: boolean;
};

type FormFieldType =
  | "TEXT"
  | "TEXT_ARRAY"
  | "TEXT_AREA"
  | "NUMBER"
  | "SELECT"
  | "MULTI_SELECT"
  | "DATE"
  | "TIME"
  | "DATETIME"
  | "CHECKBOX"
  | "SWITCH"
  | "CHECKBOX_GROUP"
  | "MULTI_CHECKBOX_GROUP";

type RawValue = string | number | boolean;
type SelectValue = { index: number; value: RawValue };
type MultiSelectValue = { index: number[]; value: RawValue[] };
type AnswerEntry = { question: string; answer: string };

type FormField = {
  name: string;
  label?: string;
  type: FormFieldType;
  hidden?: boolean;
  required?: boolean;
  requiredMsg?: string;
  readOnly?: boolean;
  placeholder?: string;
  format?: string;
  defaultValue?: RawValue | RawValue[] | SelectValue | MultiSelectValue;
  // DingTalk form protocol documentation also exposes this misspelled key.
  defautValue?: RawValue | RawValue[] | SelectValue | MultiSelectValue;
  options?: Array<{ value: string; text: string }>;
  minRows?: number;
  maxRows?: number;
  addText?: string;
};

type PendingQuestion = DingTalkQuestionContext & {
  questionId: string;
  outTrackId: string;
  title: string;
  questions: Array<{
    fieldName: string;
    title: string;
    options: Array<{ value: string; text: string }>;
    multiSelect: boolean;
  }>;
  submitted: boolean;
  ownerUserId?: string;
  ttlTimer?: ReturnType<typeof setTimeout>;
};

type HandledQuestionTombstone = {
  outTrackId: string;
  questionId: string;
  reason: "superseded" | "expired" | "submitted" | "cancelled" | "empty";
  timer?: ReturnType<typeof setTimeout>;
};

type ParsedCardCallback = {
  outTrackId?: string;
  actionId?: string;
  params: Record<string, unknown>;
  hasBusinessPayload: boolean;
};

const pendingQuestionsByTrackId = new Map<string, PendingQuestion>();
const pendingQuestionsByQuestionId = new Map<string, PendingQuestion>();
const pendingOutTrackIdsByScopeKey = new Map<string, Set<string>>();
const handledQuestionTombstonesByTrackId = new Map<string, HandledQuestionTombstone>();
const handledQuestionTombstonesByQuestionId = new Map<string, HandledQuestionTombstone>();

function jsonToolResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function stringifyCardData(data: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return result;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeUserId(value: unknown): string | undefined {
  return readString(value);
}

function resolvePendingQuestionOwner(ctx: PendingQuestion): string | undefined {
  return (
    normalizeUserId(ctx.ownerUserId) ??
    normalizeUserId(ctx.data.senderStaffId) ??
    normalizeUserId(ctx.data.senderId)
  );
}

function isOwnerClick(ctx: PendingQuestion, clickerUserId?: string): boolean {
  const ownerUserId = resolvePendingQuestionOwner(ctx);
  if (!ownerUserId) {
    return true;
  }
  const clicker = normalizeUserId(clickerUserId);
  if (!clicker) {
    return false;
  }
  const allowed = [ownerUserId, ctx.data.senderStaffId, ctx.data.senderId]
    .map((value) => normalizeUserId(value)?.toLowerCase())
    .filter((value): value is string => Boolean(value));
  return allowed.includes(clicker.toLowerCase());
}

function normalizeOption(option: AskUserOption, index: number): { value: string; text: string } {
  const text = readString(option.label) ?? readString(option.description) ?? `选项 ${index + 1}`;
  const value = readString(option.value) ?? text;
  return { value, text };
}

function normalizeFormOption(option: unknown, index: number): { value: string; text: string } {
  const record = asRecord(option) ?? {};
  const value = readString(record.value) ?? `option_${index + 1}`;
  const text = readString(record.text) ?? value;
  return { value, text };
}

export function buildQuestionForm(questions: AskUserQuestion[]): {
  title: string;
  desc: string;
  fields: FormField[];
  parsed: PendingQuestion["questions"];
} {
  const parsed = questions.map((question, index) => {
    const options = Array.isArray(question.options)
      ? question.options.map((option, optionIndex) => normalizeOption(option, optionIndex))
      : [];
    const title =
      readString(question.header) ?? readString(question.question) ?? `问题 ${index + 1}`;
    const fieldName = `${ANSWER_FIELD_PREFIX}_${index}`;
    return {
      fieldName,
      title,
      options,
      multiSelect: Boolean(question.multiSelect),
    };
  });

  const fields: FormField[] = parsed.map((question) => {
    if (question.options.length === 0) {
      return {
        name: question.fieldName,
        label: question.title,
        type: "TEXT",
        required: true,
        placeholder: "请输入回答",
      };
    }
    return {
      name: question.fieldName,
      label: question.title,
      type: question.multiSelect ? "MULTI_CHECKBOX_GROUP" : "CHECKBOX_GROUP",
      required: true,
      options: question.options,
    };
  });

  const first = questions[0] ?? {};
  const title = readString(first.header) ?? readString(first.question) ?? "需要你的确认";
  const desc = readString(first.question) ?? title;
  return { title, desc, fields, parsed };
}

const FORM_FIELD_TYPES = new Set<FormFieldType>([
  "TEXT",
  "TEXT_ARRAY",
  "TEXT_AREA",
  "NUMBER",
  "SELECT",
  "MULTI_SELECT",
  "DATE",
  "TIME",
  "DATETIME",
  "CHECKBOX",
  "SWITCH",
  "CHECKBOX_GROUP",
  "MULTI_CHECKBOX_GROUP",
]);

export function buildQuestionFormFromFields(params: {
  title?: string;
  description?: string;
  fields: FormField[];
}): {
  title: string;
  desc: string;
  fields: FormField[];
  parsed: PendingQuestion["questions"];
} {
  const fields = params.fields.map((field, index) => {
    const name = readString(field.name) ?? `${ANSWER_FIELD_PREFIX}_${index}`;
    const rawType = readString(field.type);
    const type = rawType && FORM_FIELD_TYPES.has(rawType as FormFieldType) ? rawType : "TEXT";
    const label = readString(field.label) ?? name;
    const normalized: FormField = {
      ...field,
      name,
      label,
      type: type as FormFieldType,
    };
    if (Array.isArray(field.options)) {
      normalized.options = field.options.map((option, optionIndex) =>
        normalizeFormOption(option, optionIndex),
      );
    }
    return normalized;
  });
  const parsed = fields.map((field) => ({
    fieldName: field.name,
    title: readString(field.label) ?? field.name,
    options: Array.isArray(field.options) ? field.options : [],
    multiSelect: field.type === "MULTI_CHECKBOX_GROUP" || field.type === "MULTI_SELECT",
  }));
  const firstLabel = readString(fields[0]?.label);
  const title = readString(params.title) ?? firstLabel ?? "需要你的确认";
  const desc = readString(params.description) ?? title;
  return { title, desc, fields, parsed };
}

async function createAndDeliverQuestionCard(params: {
  config: DingTalkConfig;
  conversationId: string;
  isDirect: boolean;
  templateId: string;
  outTrackId: string;
  cardData: Record<string, unknown>;
  log?: Logger;
}): Promise<void> {
  const token = await getAccessToken(params.config, params.log);
  const isGroup = !params.isDirect;
  const body = {
    cardTemplateId: params.templateId,
    outTrackId: params.outTrackId,
    cardData: {
      cardParamMap: stringifyCardData(params.cardData),
    },
    callbackType: "STREAM",
    imGroupOpenSpaceModel: { supportForward: true },
    imRobotOpenSpaceModel: { supportForward: true },
    openSpaceId: isGroup
      ? `dtv1.card//IM_GROUP.${params.conversationId}`
      : `dtv1.card//IM_ROBOT.${params.conversationId}`,
    userIdType: 1,
    imGroupOpenDeliverModel: isGroup
      ? {
          robotCode: resolveRobotCode(params.config),
          extension: { dynamicSummary: "true" },
        }
      : undefined,
    imRobotOpenDeliverModel: !isGroup
      ? {
          spaceType: "IM_ROBOT",
          robotCode: resolveRobotCode(params.config),
          extension: { dynamicSummary: "true" },
        }
      : undefined,
  };

  params.log?.debug?.(
    `[DingTalk][AskUser] POST /v1.0/card/instances/createAndDeliver body=${JSON.stringify(body)}`,
  );
  const resp = await axios.post(`${DINGTALK_API}/v1.0/card/instances/createAndDeliver`, body, {
    headers: {
      "x-acs-dingtalk-access-token": token,
      "Content-Type": "application/json",
    },
    ...getProxyBypassOption(params.config),
  });
  params.log?.debug?.(
    `[DingTalk][AskUser] createAndDeliver response status=${resp.status} data=${JSON.stringify(resp.data)}`,
  );
  const deliverResults = (
    resp.data?.result as
      | { deliverResults?: Array<{ success?: boolean; errorMsg?: string }> }
      | undefined
  )?.deliverResults;
  const failedDelivery = Array.isArray(deliverResults)
    ? deliverResults.find((item) => item?.success === false)
    : undefined;
  if (failedDelivery) {
    throw new Error(failedDelivery.errorMsg?.trim() || "DingTalk question card delivery failed");
  }
}

function removeScopeIndex(ctx: PendingQuestion): void {
  const scopeKey = readString(ctx.questionScopeKey);
  if (!scopeKey) {
    return;
  }
  const set = pendingOutTrackIdsByScopeKey.get(scopeKey);
  if (!set) {
    return;
  }
  set.delete(ctx.outTrackId);
  if (set.size === 0) {
    pendingOutTrackIdsByScopeKey.delete(scopeKey);
  }
}

function addScopeIndex(ctx: PendingQuestion): void {
  const scopeKey = readString(ctx.questionScopeKey);
  if (!scopeKey) {
    return;
  }
  let set = pendingOutTrackIdsByScopeKey.get(scopeKey);
  if (!set) {
    set = new Set();
    pendingOutTrackIdsByScopeKey.set(scopeKey, set);
  }
  set.add(ctx.outTrackId);
}

function deleteHandledQuestionTombstone(tombstone: HandledQuestionTombstone): void {
  if (handledQuestionTombstonesByTrackId.get(tombstone.outTrackId) === tombstone) {
    handledQuestionTombstonesByTrackId.delete(tombstone.outTrackId);
  }
  if (handledQuestionTombstonesByQuestionId.get(tombstone.questionId) === tombstone) {
    handledQuestionTombstonesByQuestionId.delete(tombstone.questionId);
  }
  if (tombstone.timer) {
    clearTimeout(tombstone.timer);
  }
}

function addHandledQuestionTombstone(
  ctx: PendingQuestion,
  reason: HandledQuestionTombstone["reason"],
): void {
  const existingByTrack = handledQuestionTombstonesByTrackId.get(ctx.outTrackId);
  if (existingByTrack) {
    deleteHandledQuestionTombstone(existingByTrack);
  }
  const existingByQuestion = handledQuestionTombstonesByQuestionId.get(ctx.questionId);
  if (existingByQuestion && existingByQuestion !== existingByTrack) {
    deleteHandledQuestionTombstone(existingByQuestion);
  }
  const tombstone: HandledQuestionTombstone = {
    outTrackId: ctx.outTrackId,
    questionId: ctx.questionId,
    reason,
  };
  tombstone.timer = setTimeout(() => {
    deleteHandledQuestionTombstone(tombstone);
  }, HANDLED_CALLBACK_TOMBSTONE_TTL_MS);
  if (typeof tombstone.timer === "object" && "unref" in tombstone.timer) {
    tombstone.timer.unref();
  }
  handledQuestionTombstonesByTrackId.set(ctx.outTrackId, tombstone);
  handledQuestionTombstonesByQuestionId.set(ctx.questionId, tombstone);
}

function findHandledQuestionTombstone(
  parsed: ParsedCardCallback,
): HandledQuestionTombstone | undefined {
  return (
    (parsed.outTrackId ? handledQuestionTombstonesByTrackId.get(parsed.outTrackId) : undefined) ??
    (parsed.actionId ? handledQuestionTombstonesByQuestionId.get(parsed.actionId) : undefined)
  );
}

function supersedePendingQuestionsInScope(ctx: PendingQuestion): void {
  const scopeKey = readString(ctx.questionScopeKey);
  if (!scopeKey) {
    return;
  }
  const set = pendingOutTrackIdsByScopeKey.get(scopeKey);
  if (!set) {
    return;
  }
  for (const outTrackId of Array.from(set)) {
    if (outTrackId === ctx.outTrackId) {
      continue;
    }
    const oldCtx = pendingQuestionsByTrackId.get(outTrackId);
    if (!oldCtx || oldCtx.submitted) {
      continue;
    }
    oldCtx.submitted = true;
    consumePendingQuestion(oldCtx);
    addHandledQuestionTombstone(oldCtx, "superseded");
    void updateQuestionCardBestEffort(oldCtx, {
      card_status: "expired",
      question_desc: "已有新的问题卡片，请回答最新卡片。",
      form_btn_text: "已失效",
    });
  }
}

function storePendingQuestion(
  ctx: PendingQuestion,
  options: { supersedeExisting?: boolean } = {},
): void {
  ctx.ownerUserId = resolvePendingQuestionOwner(ctx);
  if (options.supersedeExisting !== false) {
    supersedePendingQuestionsInScope(ctx);
  }
  pendingQuestionsByTrackId.set(ctx.outTrackId, ctx);
  pendingQuestionsByQuestionId.set(ctx.questionId, ctx);
  addScopeIndex(ctx);
  ctx.ttlTimer = setTimeout(() => {
    if (!pendingQuestionsByTrackId.has(ctx.outTrackId) || ctx.submitted) {
      return;
    }
    if (!claimPendingQuestionForDispatch(ctx)) {
      return;
    }
    consumePendingQuestion(ctx);
    addHandledQuestionTombstone(ctx, "expired");
    void updateQuestionCardBestEffort(ctx, {
      card_status: "expired",
      question_desc: "问题已失效，请重新发起。",
      form_btn_text: "已失效",
    });
    dispatchSyntheticAnswer({
      ctx,
      text: buildExpiredAnswerMessage(ctx),
      suffix: "expired",
      successReason: "expired",
      log: ctx.log,
    });
  }, PENDING_QUESTION_TTL_MS);
}

function consumePendingQuestion(ctx: PendingQuestion): void {
  pendingQuestionsByTrackId.delete(ctx.outTrackId);
  pendingQuestionsByQuestionId.delete(ctx.questionId);
  removeScopeIndex(ctx);
  if (ctx.ttlTimer) {
    clearTimeout(ctx.ttlTimer);
  }
}

async function updateQuestionCard(
  ctx: PendingQuestion,
  variables: Record<string, unknown>,
): Promise<void> {
  const token = await getAccessToken(ctx.dingtalkConfig, ctx.log);
  await updateCardVariables(ctx.outTrackId, variables, token, ctx.dingtalkConfig);
}

async function updateQuestionCardBestEffort(
  ctx: PendingQuestion,
  variables: Record<string, unknown>,
): Promise<void> {
  try {
    await updateQuestionCard(ctx, variables);
  } catch (err) {
    ctx.log?.warn?.(
      `[DingTalk][AskUser] Failed to update question card ${ctx.questionId}: ${String(err)}`,
    );
  }
}

function getAskUserStoreOptions(
  params: Pick<DingTalkQuestionContext, "storePath" | "accountId" | "log">,
): AskUserStoreOptions | undefined {
  if (!params.storePath) {
    return undefined;
  }
  return {
    storePath: params.storePath,
    accountId: params.accountId,
    log: params.log,
  };
}

function terminalCardVariables(reason: AskUserTerminalReason): Record<string, unknown> {
  const descriptions: Record<AskUserTerminalReason, string> = {
    delivery_failed: "问题卡片发送失败。",
    superseded_by_question: "已有新的问题卡片，请回答最新卡片。",
    superseded_by_message: "你在问题卡片发出后发送了新消息，此卡已失效。请重新发起需要填写的问题。",
    expired: "问题已失效，请重新发起。",
    cancelled: "已取消。",
    empty: "已提交，未填写任何内容。",
    submitted: "已提交。",
    pause_failed: "当前任务未能暂停，此卡已失效，请重新发起。",
    restart_invalidated: "服务已重启，原问题上下文已失效，请重新发起。",
    restart_during_dispatch: "服务在处理回答期间重启，本次处理结果可能未完成，请发送新消息继续。",
    dispatch_failed: "回答已收到，但未能继续会话，请发送一条普通消息继续。",
  };
  return {
    card_status:
      reason === "cancelled"
        ? "cancelled"
        : reason === "submitted" || reason === "empty"
          ? "submitted"
          : "expired",
    question_desc: descriptions[reason],
    form_btn_text:
      reason === "cancelled"
        ? "已取消"
        : reason === "submitted" || reason === "empty"
          ? "已提交"
          : "已失效",
  };
}

async function updateLifecycleRecordCardBestEffort(params: {
  record: AskUserLifecycleRecord;
  config: DingTalkConfig;
  log?: Logger;
}): Promise<void> {
  const reason = params.record.terminalReason;
  if (!reason || reason === "delivery_failed") {
    return;
  }
  try {
    const token = await getAccessToken(params.config, params.log);
    await updateCardVariables(
      params.record.outTrackId,
      terminalCardVariables(reason),
      token,
      params.config,
    );
  } catch (err) {
    params.log?.warn?.(
      `[DingTalk][AskUser] Failed to update lifecycle card ${params.record.questionId}: ${String(err)}`,
    );
  }
}

function consumeLifecyclePendingContext(
  record: AskUserLifecycleRecord,
): PendingQuestion | undefined {
  const ctx =
    pendingQuestionsByQuestionId.get(record.questionId) ??
    pendingQuestionsByTrackId.get(record.outTrackId);
  if (!ctx) {
    return undefined;
  }
  ctx.submitted = true;
  consumePendingQuestion(ctx);
  addHandledQuestionTombstone(ctx, record.terminalReason === "expired" ? "expired" : "superseded");
  return ctx;
}

export function invalidateAskUserQuestionsForScope(params: {
  storePath: string;
  accountId: string;
  questionScopeKey: string;
  reason: "superseded_by_message";
  log?: Logger;
}): AskUserLifecycleRecord[] {
  const invalidated = invalidateAskUserQuestionsInStore(
    {
      storePath: params.storePath,
      accountId: params.accountId,
      log: params.log,
    },
    params.questionScopeKey,
    params.reason,
  );
  for (const record of invalidated) {
    consumeLifecyclePendingContext(record);
  }
  return invalidated;
}

export async function syncInvalidatedAskUserQuestionCards(params: {
  records: AskUserLifecycleRecord[];
  config: DingTalkConfig;
  log?: Logger;
}): Promise<void> {
  await Promise.allSettled(
    params.records.map((record) =>
      updateLifecycleRecordCardBestEffort({
        record,
        config: params.config,
        log: params.log,
      }),
    ),
  );
}

export async function recoverAskUserQuestionsForAccount(params: {
  storePath?: string;
  accountId: string;
  config: DingTalkConfig;
  log?: Logger;
}): Promise<number> {
  if (!params.storePath) {
    return 0;
  }
  const recovered = recoverAskUserQuestionsAfterRestart({
    storePath: params.storePath,
    accountId: params.accountId,
    log: params.log,
  });
  for (const record of recovered) {
    consumeLifecyclePendingContext(record);
    await updateLifecycleRecordCardBestEffort({
      record,
      config: params.config,
      log: params.log,
    });
  }
  return recovered.length;
}

async function terminatePendingQuestion(params: {
  ctx: PendingQuestion;
  reason: AskUserTerminalReason;
}): Promise<void> {
  const storeOptions = getAskUserStoreOptions(params.ctx);
  if (storeOptions) {
    terminateAskUserQuestion(storeOptions, params.ctx.questionId, params.reason);
  }
  params.ctx.submitted = true;
  consumePendingQuestion(params.ctx);
  addHandledQuestionTombstone(
    params.ctx,
    params.reason === "cancelled"
      ? "cancelled"
      : params.reason === "empty"
        ? "empty"
        : params.reason === "submitted"
          ? "submitted"
          : params.reason === "expired"
            ? "expired"
            : "superseded",
  );
  await updateQuestionCardBestEffort(params.ctx, terminalCardVariables(params.reason));
}

function parseEmbeddedJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function parseAskUserCardCallback(payload: unknown): ParsedCardCallback {
  const record = asRecord(payload) ?? {};
  const content = asRecord(parseEmbeddedJson(record.content));
  const value = asRecord(parseEmbeddedJson(record.value));
  const privateData =
    asRecord(content?.cardPrivateData) ??
    asRecord(parseEmbeddedJson(record.cardPrivateData)) ??
    asRecord(value?.cardPrivateData);
  const params =
    asRecord(privateData?.params) ?? asRecord(content?.params) ?? asRecord(value?.params) ?? {};
  const actionIds = privateData?.actionIds;
  const actionId =
    Array.isArray(actionIds) && typeof actionIds[0] === "string" ? actionIds[0] : undefined;
  const outTrackId =
    readString(record.outTrackId) ??
    readString(content?.outTrackId) ??
    readString(value?.outTrackId) ??
    readString(privateData?.outTrackId);
  return {
    outTrackId,
    actionId,
    params,
    hasBusinessPayload: Boolean(params.form || params.user_cancel),
  };
}

function readFormAnswer(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const raw = record.value;
    if (Array.isArray(raw)) {
      return raw.map((item) => String(item));
    }
    if (raw !== undefined && raw !== null) {
      return [String(raw)];
    }
  }
  return [String(value)];
}

function formatAnswerText(
  question: PendingQuestion["questions"][number],
  values: string[],
): string {
  if (values.length === 0) {
    return "";
  }
  const labels = values.map((value) => {
    return question.options.find((option) => option.value === value)?.text ?? value;
  });
  return labels.join(", ");
}

function buildAnswerMessage(ctx: PendingQuestion, answers: AnswerEntry[]): string {
  const lines = answers.map(({ question, answer }) => `- ${question}: ${answer}`);
  return [
    "用户回答了交互卡片:",
    `- question_id: ${ctx.questionId}`,
    `- question_title: ${ctx.title}`,
    "- status: submitted",
    "- answers:",
    ...lines.map((line) => `  ${line}`),
  ].join("\n");
}

function buildEmptyAnswerMessage(ctx: PendingQuestion): string {
  return [
    "用户提交了空交互卡片:",
    `- question_id: ${ctx.questionId}`,
    `- question_title: ${ctx.title}`,
    "- status: submitted",
  ].join("\n");
}

function buildCancelledAnswerMessage(ctx: PendingQuestion): string {
  return [
    "用户取消了交互卡片:",
    `- question_id: ${ctx.questionId}`,
    `- question_title: ${ctx.title}`,
    "- status: cancelled",
  ].join("\n");
}

function buildExpiredAnswerMessage(ctx: PendingQuestion): string {
  return [
    "交互卡片已超时:",
    `- question_id: ${ctx.questionId}`,
    `- question_title: ${ctx.title}`,
    "- status: expired",
  ].join("\n");
}

async function injectAnswerSyntheticMessage(
  ctx: PendingQuestion,
  text: string,
  suffix: string,
): Promise<void> {
  const syntheticData: DingTalkInboundMessage = {
    // Keep this origin-derived synthetic id stable and unique. If inbound
    // dedup/self-filter/auth gates move here later, reinjected ask-user answers
    // must still pass or the waiting session can hang.
    msgId: `${ctx.data.msgId || ctx.outTrackId}:ask-user-${suffix}:${ctx.questionId}`,
    msgtype: "text",
    createAt: Date.now(),
    text: { content: text },
    conversationType: ctx.data.conversationType,
    conversationId: ctx.data.conversationId,
    conversationTitle: ctx.data.conversationTitle,
    senderId: ctx.data.senderId,
    senderStaffId: ctx.data.senderStaffId,
    senderNick: ctx.data.senderNick,
    chatbotUserId: ctx.data.chatbotUserId,
    sessionWebhook: ctx.data.sessionWebhook,
  };
  await handleDingTalkMessage({
    cfg: ctx.cfg,
    accountId: ctx.accountId,
    data: syntheticData,
    sessionWebhook: ctx.sessionWebhook,
    log: ctx.log,
    dingtalkConfig: ctx.dingtalkConfig,
    inboundOrigin: "ask-user",
    routeOverride: ctx.resolvedRoute,
    subAgentOptions: ctx.continuationSubAgentOptions,
  });
}

function claimPendingQuestionForDispatch(ctx: PendingQuestion): boolean {
  const storeOptions = getAskUserStoreOptions(ctx);
  if (storeOptions) {
    return Boolean(
      claimAskUserQuestion(storeOptions, {
        questionId: ctx.questionId,
        outTrackId: ctx.outTrackId,
      }),
    );
  }
  if (ctx.submitted) {
    return false;
  }
  ctx.submitted = true;
  return true;
}

function dispatchSyntheticAnswer(params: {
  ctx: PendingQuestion;
  text: string;
  suffix: string;
  successReason: "submitted" | "cancelled" | "empty" | "expired";
  log?: Logger;
}): void {
  const storeOptions = getAskUserStoreOptions(params.ctx);
  void injectAnswerSyntheticMessage(params.ctx, params.text, params.suffix)
    .then(() => {
      if (storeOptions) {
        terminateAskUserQuestion(storeOptions, params.ctx.questionId, params.successReason);
      }
    })
    .catch((err) => {
      if (storeOptions) {
        terminateAskUserQuestion(storeOptions, params.ctx.questionId, "dispatch_failed");
      }
      void updateQuestionCardBestEffort(params.ctx, terminalCardVariables("dispatch_failed"));
      params.log?.error?.(
        `[DingTalk][AskUser] Failed to inject ${params.suffix} answer message: ${String(err)}`,
      );
    });
}

export async function handleDingTalkAskUserCardCallback(params: {
  payload: unknown;
  cfg: DingTalkQuestionContext["cfg"];
  accountId: string;
  storePath?: string;
  config: DingTalkConfig;
  clickerUserId?: string;
  log?: Logger;
}): Promise<{ handled: boolean }> {
  const parsed = parseAskUserCardCallback(params.payload);
  const tombstone = findHandledQuestionTombstone(parsed);
  if (tombstone) {
    params.log?.debug?.(
      `[DingTalk][AskUser] Ignoring handled callback question=${tombstone.questionId} reason=${tombstone.reason}`,
    );
    return { handled: true };
  }
  const storeOptions = params.storePath
    ? {
        storePath: params.storePath,
        accountId: params.accountId,
        log: params.log,
      }
    : undefined;
  const lifecycleRecord = storeOptions
    ? resolveAskUserQuestion(storeOptions, {
        questionId: parsed.actionId,
        outTrackId: parsed.outTrackId,
      })
    : undefined;
  if (lifecycleRecord?.state === "terminal") {
    params.log?.debug?.(
      `[DingTalk][AskUser] Ignoring terminal callback question=${lifecycleRecord.questionId} reason=${lifecycleRecord.terminalReason ?? "unknown"}`,
    );
    await updateLifecycleRecordCardBestEffort({
      record: lifecycleRecord,
      config: params.config,
      log: params.log,
    });
    return { handled: true };
  }
  const ctx =
    (parsed.outTrackId ? pendingQuestionsByTrackId.get(parsed.outTrackId) : undefined) ??
    (parsed.actionId ? pendingQuestionsByQuestionId.get(parsed.actionId) : undefined);
  if (!ctx) {
    if (lifecycleRecord && storeOptions) {
      const recovered = terminateAskUserQuestion(
        storeOptions,
        lifecycleRecord.questionId,
        lifecycleRecord.state === "dispatching" ? "restart_during_dispatch" : "restart_invalidated",
      );
      if (recovered) {
        await updateLifecycleRecordCardBestEffort({
          record: recovered,
          config: params.config,
          log: params.log,
        });
      }
      return { handled: true };
    }
    return { handled: false };
  }

  if (!isOwnerClick(ctx, params.clickerUserId)) {
    params.log?.info?.(
      `[DingTalk][AskUser] rejected: clicker=${params.clickerUserId ?? "unknown"} owner=${resolvePendingQuestionOwner(ctx) ?? "unknown"} question=${ctx.questionId}`,
    );
    return { handled: true };
  }

  if (!parsed.hasBusinessPayload) {
    params.log?.debug?.(
      `[DingTalk][AskUser] Ignoring non-business card callback outTrackId=${ctx.outTrackId}`,
    );
    return { handled: true };
  }

  if (ctx.submitted || lifecycleRecord?.state === "dispatching") {
    params.log?.debug?.(`[DingTalk][AskUser] Duplicate submit ignored question=${ctx.questionId}`);
    return { handled: true };
  }

  const isCancel = parseBooleanLike(parsed.params.user_cancel) === true;

  if (isCancel) {
    if (!claimPendingQuestionForDispatch(ctx)) {
      return { handled: true };
    }
    await updateQuestionCardBestEffort(ctx, {
      card_status: "cancelled",
      question_desc: "已取消。",
      form_btn_text: "已取消",
    });
    consumePendingQuestion(ctx);
    addHandledQuestionTombstone(ctx, "cancelled");
    dispatchSyntheticAnswer({
      ctx,
      text: buildCancelledAnswerMessage(ctx),
      suffix: "cancelled",
      successReason: "cancelled",
      log: params.log,
    });
    return { handled: true };
  }

  const form = asRecord(parsed.params.form);
  if (!form) {
    params.log?.warn?.(
      `[DingTalk][AskUser] Missing form payload question=${ctx.questionId} params=${JSON.stringify(parsed.params)}`,
    );
    return { handled: true };
  }

  if (!claimPendingQuestionForDispatch(ctx)) {
    return { handled: true };
  }

  const answers: AnswerEntry[] = [];
  const selectedValues: string[] = [];
  for (const question of ctx.questions) {
    const values = readFormAnswer(form[question.fieldName]);
    selectedValues.push(...values);
    const answerText = formatAnswerText(question, values);
    if (answerText) {
      answers.push({ question: question.title, answer: answerText });
    }
  }

  if (answers.length === 0) {
    params.log?.warn?.(
      `[DingTalk][AskUser] Empty form answer question=${ctx.questionId} form=${JSON.stringify(form)}`,
    );
    await updateQuestionCardBestEffort(ctx, {
      card_status: "submitted",
      question_desc: "已提交，未填写任何内容。",
      selected_text: "",
      selected_values: "[]",
      form_btn_text: "已提交",
    });
    consumePendingQuestion(ctx);
    addHandledQuestionTombstone(ctx, "empty");
    dispatchSyntheticAnswer({
      ctx,
      text: buildEmptyAnswerMessage(ctx),
      suffix: "empty",
      successReason: "empty",
      log: params.log,
    });
    return { handled: true };
  }

  const selectedText = answers.map(({ answer }) => answer).join(", ");
  await updateQuestionCardBestEffort(ctx, {
    card_status: "submitted",
    question_desc: `已选择：${selectedText}。`,
    selected_text: selectedText,
    selected_values: JSON.stringify(selectedValues),
    form_btn_text: "已提交",
  });
  consumePendingQuestion(ctx);
  addHandledQuestionTombstone(ctx, "submitted");

  const message = buildAnswerMessage(ctx, answers);
  dispatchSyntheticAnswer({
    ctx,
    text: message,
    suffix: "submitted",
    successReason: "submitted",
    log: params.log,
  });
  return { handled: true };
}

const AskUserQuestionSchema = {
  type: "object",
  additionalProperties: false,
  anyOf: [{ required: ["questions"] }, { required: ["fields"] }],
  properties: {
    title: {
      type: "string",
      description: "Card title. Used with fields; omit to use the first field label.",
    },
    description: {
      type: "string",
      description: "Short description shown above the form. Used with fields.",
    },
    questions: {
      type: "array",
      description:
        "Lightweight blocking question DSL for simple confirmation, single-select, multi-select, or simple free-text prompts. Prefer exactly one question per card. " +
        "Do not use questions for complex forms, multiple structured fields, date/time inputs, numeric inputs, boolean switches, or mixed input collection; use top-level fields for those cases. " +
        "Do not use for explanations, status updates, capability introductions, or retrospective questions.",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "header", "options"],
        properties: {
          question: { type: "string", description: "The question to ask the user" },
          header: { type: "string", description: "Short label for the question (max 12 chars)" },
          options: {
            type: "array",
            maxItems: 20,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label"],
              properties: {
                label: { type: "string", description: "Display text for this option" },
                value: {
                  type: "string",
                  description:
                    "Machine-readable value returned to the assistant; omit to use label",
                },
                description: {
                  type: "string",
                  description: "Explanation of what this option means",
                },
              },
            },
            description:
              "Available choices. Leave empty ([]) for free-text input — the user will see a text field instead. " +
              "Use two options for confirmation.",
          },
          multiSelect: {
            type: "boolean",
            description: "Whether multiple options can be selected (ignored when options is empty)",
          },
        },
      },
    },
    fields: {
      type: "array",
      description:
        "Advanced DingTalk form fields. Use top-level fields when collecting multiple inputs, " +
        "when the user asks to fill a form, or when you would otherwise list required parameters in markdown. " +
        "Use one fields card to collect all missing inputs for the current turn; do not split related fields into multiple cards. " +
        "Do not answer with a markdown checklist when these fields are needed. The plugin will send " +
        "these fields as the DingTalk card variable form, shaped as { fields }. Do not wrap fields inside form. " +
        "For simple confirmation, single-select, or multi-select questions, prefer questions. Do not mix fields with questions. " +
        "For choice fields (SELECT, MULTI_SELECT, CHECKBOX_GROUP, MULTI_CHECKBOX_GROUP), " +
        "provide options as { value, text }. Use TEXT for single-line text, TEXT_AREA for " +
        "multi-line text, NUMBER for numeric input, DATE/TIME/DATETIME for date or time inputs, " +
        "and CHECKBOX or SWITCH for boolean inputs.",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "label", "type"],
        properties: {
          name: { type: "string", description: "Unique form field key" },
          label: { type: "string", description: "Field label shown to the user" },
          type: {
            type: "string",
            enum: [
              "TEXT",
              "TEXT_ARRAY",
              "TEXT_AREA",
              "NUMBER",
              "SELECT",
              "MULTI_SELECT",
              "DATE",
              "TIME",
              "DATETIME",
              "CHECKBOX",
              "SWITCH",
              "CHECKBOX_GROUP",
              "MULTI_CHECKBOX_GROUP",
            ],
            description: "DingTalk form field type",
          },
          hidden: { type: "boolean" },
          required: { type: "boolean" },
          requiredMsg: { type: "string" },
          readOnly: { type: "boolean" },
          placeholder: { type: "string" },
          defaultValue: {},
          defautValue: {
            description:
              "Compatibility alias for DingTalk form protocol documentation typo; prefer defaultValue when possible.",
          },
          options: {
            type: "array",
            description:
              "Required for SELECT, MULTI_SELECT, CHECKBOX_GROUP, and MULTI_CHECKBOX_GROUP. Each option must be { value, text }.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["value", "text"],
              properties: {
                value: { type: "string" },
                text: { type: "string" },
              },
            },
          },
          minRows: { type: "number" },
          maxRows: { type: "number" },
          addText: { type: "string" },
        },
      },
    },
  },
} as const;

export function getAskUserQuestionSchemaForTest(): typeof AskUserQuestionSchema {
  return AskUserQuestionSchema;
}

export function registerPendingQuestionForTest(
  ctx: Omit<PendingQuestion, "ttlTimer" | "submitted"> & { submitted?: boolean },
): void {
  storePendingQuestion({
    ...ctx,
    submitted: Boolean(ctx.submitted),
  });
}

export function clearPendingQuestionsForTest(): void {
  for (const ctx of pendingQuestionsByTrackId.values()) {
    if (ctx.ttlTimer) {
      clearTimeout(ctx.ttlTimer);
    }
  }
  const tombstones = new Set([
    ...handledQuestionTombstonesByTrackId.values(),
    ...handledQuestionTombstonesByQuestionId.values(),
  ]);
  for (const tombstone of tombstones) {
    if (tombstone.timer) {
      clearTimeout(tombstone.timer);
    }
  }
  pendingQuestionsByTrackId.clear();
  pendingQuestionsByQuestionId.clear();
  pendingOutTrackIdsByScopeKey.clear();
  handledQuestionTombstonesByTrackId.clear();
  handledQuestionTombstonesByQuestionId.clear();
}

export function registerDingTalkAskUserQuestionTool(api: OpenClawPluginApi): void {
  const registerTool = (
    api as OpenClawPluginApi & { registerTool?: OpenClawPluginApi["registerTool"] }
  ).registerTool;
  api.logger?.debug?.(
    `${TOOL_NAME}: register hook invoked, mode=${api.registrationMode ?? "unknown"}, registerTool=${typeof registerTool}`,
  );
  if (typeof registerTool !== "function") {
    api.logger?.warn?.(`${TOOL_NAME}: registerTool unavailable, skipping tool registration`);
    return;
  }

  const createTool = (context: DingTalkQuestionContext | undefined) => ({
    name: TOOL_NAME,
    label: "Ask User Question",
    description:
      "Ask the user a blocking question or collect structured input via an interactive DingTalk form card when the current task cannot continue without the user's answer. " +
      "Returns immediately after sending the card. " +
      "The user's answer will arrive as a new message in the conversation. " +
      "Do NOT poll or re-call this tool — just wait for the response message. " +
      "Use questions only for simple confirmation, single-select, multi-select, or simple free-text prompts. " +
      "For simple selection questions, provide options; for simple free-text input, set options to an empty array. " +
      "When collecting multiple missing values, when the user asks for a form, or when you would otherwise list required parameters for the user to fill, call this tool with top-level fields instead of replying with a markdown checklist. " +
      "Do not call this tool for normal explanations, why/how questions, capability introductions, or cases where you can answer directly.",
    parameters: AskUserQuestionSchema as any,
    async execute(_toolCallId: string, params: unknown) {
      if (!context) {
        return jsonToolResult({
          status: "failed",
          error: "dingtalk_ask_user_question can only be used in a DingTalk message context",
        });
      }
      const templateId = DINGTALK_ASK_USER_CARD_TEMPLATE.templateId;

      const record = asRecord(params) ?? {};
      const rawFields = Array.isArray(record.fields) ? (record.fields as FormField[]) : [];
      const rawQuestions = Array.isArray(record.questions)
        ? (record.questions as AskUserQuestion[])
        : [];
      if (rawFields.length === 0 && rawQuestions.length === 0) {
        return jsonToolResult({
          status: "failed",
          error: "questions or fields must contain at least one item",
        });
      }

      const questionId = `q_${randomUUID()}`;
      const outTrackId = `ask_${randomUUID()}`;
      const { title, desc, fields, parsed } =
        rawFields.length > 0
          ? buildQuestionFormFromFields({
              title: readString(record.title),
              description: readString(record.description),
              fields: rawFields,
            })
          : buildQuestionForm(rawQuestions);
      const cardData = {
        question_id: questionId,
        question_title: title,
        question_desc: desc,
        card_status: "pending",
        form_btn_text: "提交",
        selected_text: "",
        selected_values: "[]",
        form: { fields },
      };
      const storeOptions = getAskUserStoreOptions(context);
      const canPersistLifecycle = Boolean(storeOptions && context.questionScopeKey);
      if (storeOptions && context.questionScopeKey) {
        reserveAskUserQuestion(storeOptions, {
          questionId,
          questionScopeKey: context.questionScopeKey,
          outTrackId,
          title,
        });
      }

      try {
        await createAndDeliverQuestionCard({
          config: context.dingtalkConfig,
          conversationId:
            context.data.conversationType === "1"
              ? context.data.senderStaffId || context.data.senderId || context.data.conversationId
              : context.data.conversationId,
          isDirect: context.data.conversationType === "1",
          templateId,
          outTrackId,
          cardData,
          log: context.log,
        });
      } catch (err) {
        if (storeOptions && canPersistLifecycle) {
          terminateAskUserQuestion(storeOptions, questionId, "delivery_failed");
        }
        const detail = formatDingTalkErrorPayloadLog("ask_user_create", err, "[DingTalk]");
        return jsonToolResult({
          status: "failed",
          error: detail || (err instanceof Error ? err.message : String(err)),
        });
      }
      const pendingContext: DingTalkQuestionContext = {
        ...context,
        onQuestionCardSent: undefined,
      };
      const pendingQuestion: PendingQuestion = {
        ...pendingContext,
        questionId,
        outTrackId,
        title,
        questions: parsed,
        submitted: false,
      };
      storePendingQuestion(pendingQuestion, {
        supersedeExisting: !canPersistLifecycle,
      });
      if (storeOptions && canPersistLifecycle) {
        const activation = activateAskUserQuestion(storeOptions, questionId);
        if (activation.record?.state !== "pending") {
          const terminalReason = activation.record?.terminalReason ?? "superseded_by_message";
          if (activation.record) {
            consumeLifecyclePendingContext(activation.record);
          } else {
            pendingQuestion.submitted = true;
            consumePendingQuestion(pendingQuestion);
            addHandledQuestionTombstone(pendingQuestion, "superseded");
          }
          await updateQuestionCardBestEffort(
            pendingQuestion,
            terminalCardVariables(terminalReason),
          );
          return jsonToolResult({
            status: "failed",
            questionId,
            outTrackId,
            error: "问题卡片在发送期间已失效，请重新发起。",
          });
        }
        for (const superseded of activation.superseded) {
          const supersededContext = consumeLifecyclePendingContext(superseded);
          if (supersededContext) {
            void updateQuestionCardBestEffort(
              supersededContext,
              terminalCardVariables("superseded_by_question"),
            );
          } else {
            void updateLifecycleRecordCardBestEffort({
              record: superseded,
              config: context.dingtalkConfig,
              log: context.log,
            });
          }
        }
      }

      let takeoverSucceeded: boolean | void = undefined;
      try {
        takeoverSucceeded = await context.onQuestionCardSent?.({ questionId, outTrackId });
      } catch (err) {
        context.log?.warn?.(
          `[DingTalk][AskUser] onQuestionCardSent hook failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        takeoverSucceeded = false;
      }
      if (takeoverSucceeded === false) {
        await terminatePendingQuestion({
          ctx: pendingQuestion,
          reason: "pause_failed",
        });
        return jsonToolResult({
          status: "failed",
          questionId,
          outTrackId,
          error: "当前任务未能暂停，此卡已失效，请重新发起。",
        });
      }

      context.log?.info?.(
        `[DingTalk][AskUser] question card sent question=${questionId} outTrackId=${outTrackId}`,
      );
      return jsonToolResult({
        status: "pending",
        questionId,
        outTrackId,
        message:
          "Question card sent to the user. Their answer will arrive as a follow-up message in this conversation.",
      });
    },
  });
  registerTool.call(
    api,
    (toolContext: OpenClawPluginToolContext) => {
      // Capture the inbound run's context while the factory is still inside its
      // AsyncLocalStorage scope; shared agent clients may execute the tool later.
      const context = getDingTalkQuestionContext();
      const runtimeSessionKey = toolContext.sessionKey?.trim();
      const contextSessionKey = context?.resolvedRoute?.sessionKey.trim();
      return createTool(
        context && (!runtimeSessionKey || contextSessionKey === runtimeSessionKey)
          ? context
          : undefined,
      );
    },
    { name: TOOL_NAME },
  );
  api.logger?.debug?.(`${TOOL_NAME}: registered tool`);
}
