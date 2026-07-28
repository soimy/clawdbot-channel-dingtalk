import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  hasConfiguredSecretInput as hasConfiguredOpenClawSecretInput,
  resolveConfiguredSecretInputString,
} from "openclaw/plugin-sdk/secret-input-runtime";
import { z } from "zod";
import { getDingTalkRuntime } from "./runtime";

export type SecretInputRef = {
  source: "env" | "file";
  provider: string;
  id: string;
};

export type SecretInput = string | SecretInputRef;

export type SecretInputResolutionFailure = {
  source: SecretInputRef["source"];
  provider: string;
  id: string;
  reason: string;
};

type SecretInputLog = {
  warn?: (message: string, data?: unknown) => void;
};

const SECRET_INPUT_PROVIDER_PATTERN = /^[^:>]+$/;
const SECRET_INPUT_ID_PATTERN = /^[^>]+$/;

function buildSecretInputFailure(
  value: SecretInputRef,
  reason: string,
): SecretInputResolutionFailure {
  return {
    source: value.source,
    provider: value.provider,
    id: value.id,
    reason,
  };
}

export function formatSecretInputResolutionFailure(failure: SecretInputResolutionFailure): string {
  return `${failure.source}:${failure.provider}:${failure.id} - ${failure.reason}`;
}

export function buildSecretInputSchema() {
  return z.union([
    z.string(),
    z.object({
      source: z.enum(["env", "file"]),
      provider: z.string().min(1).max(1024).regex(SECRET_INPUT_PROVIDER_PATTERN),
      id: z.string().min(1).max(1024).regex(SECRET_INPUT_ID_PATTERN),
    }),
  ]);
}

export function isSecretInputRef(value: unknown): value is SecretInputRef {
  if (!value || typeof value !== "object") {
    return false;
  }
  const ref = value as SecretInputRef;
  return (
    (ref.source === "env" || ref.source === "file") &&
    typeof ref.provider === "string" &&
    ref.provider.trim().length > 0 &&
    SECRET_INPUT_PROVIDER_PATTERN.test(ref.provider) &&
    typeof ref.id === "string" &&
    ref.id.trim().length > 0 &&
    SECRET_INPUT_ID_PATTERN.test(ref.id)
  );
}

export function hasConfiguredSecretInput(value: unknown): boolean {
  return hasConfiguredOpenClawSecretInput(value);
}

export function normalizeSecretInputString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!isSecretInputRef(value)) {
    return undefined;
  }
  return `<${value.source}:${value.provider}:${value.id}>`;
}

export function parseSecretInputString(value: unknown): SecretInput | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(/^<(env|file):([^:>]+):([^>]+)>$/);
  if (!match) {
    return trimmed;
  }
  return {
    source: match[1] as SecretInputRef["source"],
    provider: match[2],
    id: match[3],
  };
}

export async function resolveSecretInputString(
  value: unknown,
  log?: SecretInputLog,
  hostConfig?: OpenClawConfig,
): Promise<string | undefined> {
  return (await resolveSecretInputStringWithFailure(value, log, hostConfig)).value;
}

export async function resolveSecretInputStringWithFailure(
  value: unknown,
  log?: SecretInputLog,
  hostConfig?: OpenClawConfig,
): Promise<{ value?: string; failure?: SecretInputResolutionFailure }> {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return { value: trimmed || undefined };
  }
  if (!isSecretInputRef(value)) {
    return {};
  }
  if (!hostConfig) {
    try {
      hostConfig = getDingTalkRuntime().config.current() as OpenClawConfig;
    } catch {
      hostConfig = {} as OpenClawConfig;
    }
  }
  try {
    const resolved = await resolveConfiguredSecretInputString({
      config: hostConfig,
      env: process.env,
      value,
      path: "channels.dingtalk.clientSecret",
      unresolvedReasonStyle: "detailed",
    });
    if (resolved.value) {
      return { value: resolved.value };
    }
    const failure = buildSecretInputFailure(
      value,
      resolved.unresolvedRefReason || "secret reference is unresolved",
    );
    log?.warn?.("[DingTalk][SecretInput] Failed to resolve secret", {
      provider: value.provider,
      id: value.id,
      error: failure.reason,
    });
    return { failure };
  } catch (error) {
    const failure = buildSecretInputFailure(
      value,
      error instanceof Error ? error.message : String(error),
    );
    log?.warn?.("[DingTalk][SecretInput] Failed to resolve secret", {
      provider: value.provider,
      id: value.id,
      error: failure.reason,
    });
    return { failure };
  }
}

export async function resolveDingTalkSecretConfig<T extends { clientSecret?: unknown }>(
  config: T,
  log?: SecretInputLog,
): Promise<
  T & { clientSecret?: string; clientSecretResolutionFailure?: SecretInputResolutionFailure }
> {
  const resolvedSecret = await resolveSecretInputStringWithFailure(config.clientSecret, log);
  return {
    ...config,
    clientSecret: resolvedSecret.value,
    clientSecretResolutionFailure: resolvedSecret.failure,
  };
}
