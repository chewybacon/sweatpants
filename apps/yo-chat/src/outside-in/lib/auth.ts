/**
 * Selected-model auth precondition for live outside-in flows.
 *
 * This is intentionally a synchronous availability check; the global setup
 * refreshes OAuth through `pnpm model:auth:refresh` before these flows begin.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  isYoChatAuthProvider,
  readStoredModelSelection,
  sweatpantsAuthFile,
  type YoChatAuthProvider,
} from "@sweatpants/model-provider-pi-ai";

export interface ModelAuthStatus {
  readonly ok: boolean;
  readonly provider: string;
  readonly source: string;
  readonly expiresAt?: number;
  readonly reason?: string;
}

function selectedProvider(): YoChatAuthProvider {
  const selected = readStoredModelSelection();
  const provider =
    process.env["DEFAULT_CHAT_MODEL_PROVIDER"] ?? selected?.provider ?? "github-copilot";
  if (!isYoChatAuthProvider(provider)) {
    throw new Error(`[outside-in] ${provider} is not a managed live-model provider`);
  }
  return provider;
}

function environmentKey(provider: YoChatAuthProvider): string | undefined {
  if (provider === "github-copilot") {
    return process.env["COPILOT_GITHUB_TOKEN"];
  }
  if (provider === "opencode") {
    return process.env["OPENCODE_API_KEY"];
  }
  return undefined;
}

function storedCredential(provider: YoChatAuthProvider): Record<string, unknown> | undefined {
  const path = sweatpantsAuthFile();
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      credentials?: Record<string, unknown>;
    };
    const credential = parsed.credentials?.[provider];
    return credential && typeof credential === "object" && !Array.isArray(credential)
      ? (credential as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function getModelAuthStatus(): ModelAuthStatus {
  const provider = selectedProvider();
  const environment = environmentKey(provider);
  if (environment?.trim()) {
    return {
      ok: true,
      provider,
      source: provider === "opencode" ? "OPENCODE_API_KEY" : "COPILOT_GITHUB_TOKEN",
    };
  }
  const credential = storedCredential(provider);
  const path = sweatpantsAuthFile();
  if (!credential) {
    return { ok: false, provider, source: path, reason: "credential not found" };
  }
  if (provider === "opencode") {
    return typeof credential["key"] === "string" && credential["key"].trim()
      ? { ok: true, provider, source: path }
      : { ok: false, provider, source: path, reason: "API key not found" };
  }
  const expires = credential["expires"];
  const expiresAt = typeof expires === "number" ? expires : undefined;
  if (
    credential["type"] !== "oauth" ||
    typeof credential["access"] !== "string" ||
    typeof credential["refresh"] !== "string"
  ) {
    return { ok: false, provider, source: path, reason: "OAuth credential is invalid" };
  }
  if (expiresAt !== undefined && expiresAt <= Date.now()) {
    return { ok: false, provider, source: path, expiresAt, reason: "OAuth token expired" };
  }
  return {
    ok: true,
    provider,
    source:
      path /* CONDITIONAL-SPREAD: Omit absent expiresAt from chat requests and authored tool results; explicit undefined is not a portable JSON value. */,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

export function requireModelAuth(): ModelAuthStatus {
  const status = getModelAuthStatus();
  if (!status.ok) {
    throw new Error(
      `[outside-in] ${status.provider} auth precondition failed (${status.reason ?? "unknown"}; source=${status.source}). Run \`pnpm model:auth:login --provider ${status.provider}\` and retry.`,
    );
  }
  return status;
}
