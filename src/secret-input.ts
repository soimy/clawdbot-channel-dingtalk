import { readFile } from "node:fs/promises";
import { hasConfiguredSecretInput as hasConfiguredOpenClawSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { z } from "zod";
import { resolveRelativePath } from "./path-utils";

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
): Promise<string | undefined> {
  return (await resolveSecretInputStringWithFailure(value, log)).value;
}

export async function resolveSecretInputStringWithFailure(
  value: unknown,
  log?: SecretInputLog,
): Promise<{ value?: string; failure?: SecretInputResolutionFailure }> {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return { value: trimmed || undefined };
  }
  if (!isSecretInputRef(value)) {
    return {};
  }
  if (value.source === "env") {
    const envValue = process.env[value.id]?.trim();
    if (envValue) {
      return { value: envValue };
    }
    const failure = buildSecretInputFailure(value, "environment variable is not set or is empty");
    log?.warn?.("[DingTalk][SecretInput] Failed to resolve env secret", {
      provider: value.provider,
      id: value.id,
      error: failure.reason,
    });
    return { failure };
  }
  try {
    // Trust boundary: file SecretInput reads the configured local path. Use it
    // only with trusted plugin configuration.
    const filePath = resolveRelativePath(value.id);
    const secret = (await readFile(filePath, "utf8")).trim();
    if (secret) {
      return { value: secret };
    }
    return { failure: buildSecretInputFailure(value, "file secret is empty") };
  } catch (error) {
    const failure = buildSecretInputFailure(
      value,
      error instanceof Error ? error.message : String(error),
    );
    log?.warn?.("[DingTalk][SecretInput] Failed to read file secret", {
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
