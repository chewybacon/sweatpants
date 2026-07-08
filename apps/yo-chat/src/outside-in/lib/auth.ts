/**
 * Copilot auth precondition for the live-model tier (design R9/C5).
 *
 * Copilot access tokens are short-lived (~25 min after refresh). Rather than
 * letting a live flow hang and time out, the tier reads/validates the token up
 * front and fails fast with a clear, actionable message pointing at the
 * documented refresh path.
 *
 * Token lookup mirrors `@sweatpants/model-provider-pi-ai`:
 *   1. `COPILOT_GITHUB_TOKEN`
 *   2. `SWEATPANTS_AUTH_FILE` or `~/.sweatpants/auth.json`
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

const REFRESH_REMEDY = "Run `pnpm copilot:auth:refresh` then `pnpm copilot:auth:sync` and retry.";

export interface CopilotAuthStatus {
  ok: boolean;
  source: string;
  /** Expiry (epoch ms) when derivable from the token/record; else undefined. */
  expiresAt?: number;
  reason?: string;
}

function authFilePath(): string {
  return process.env["SWEATPANTS_AUTH_FILE"] ?? `${homedir()}/.sweatpants/auth.json`;
}

function parseTokenFields(token: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of token.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  }
  return fields;
}

function expiryFromToken(token: string): number | undefined {
  const fields = parseTokenFields(token);
  const raw = fields["exp"] ?? fields["expires_at"] ?? fields["expiresAt"];
  if (!raw) {
    return undefined;
  }
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

function readAuthFileRecord(): { access?: string; expires?: number } | undefined {
  const path = authFilePath();
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      ["github-copilot"]?: { access?: unknown; expires?: unknown };
    };
    const record = parsed["github-copilot"];
    if (!record) {
      return undefined;
    }
    const result: { access?: string; expires?: number } = {};
    if (typeof record.access === "string") {
      result.access = record.access;
    }
    if (typeof record.expires === "number") {
      result.expires = record.expires;
    }
    return result;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the current Copilot auth status without throwing. Reports the token
 * source, derived expiry, and whether it is currently usable.
 */
export function getCopilotAuthStatus(): CopilotAuthStatus {
  const envToken = process.env["COPILOT_GITHUB_TOKEN"];
  if (envToken && envToken.trim().length > 0) {
    const expiresAt = expiryFromToken(envToken);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      return { ok: false, source: "COPILOT_GITHUB_TOKEN", expiresAt, reason: "token expired" };
    }
    return {
      ok: true,
      source: "COPILOT_GITHUB_TOKEN",
      ...(expiresAt !== undefined && { expiresAt }),
    };
  }

  const record = readAuthFileRecord();
  const source = authFilePath();
  if (!record?.access || record.access.trim().length === 0) {
    return { ok: false, source, reason: "no github-copilot access token found" };
  }
  const expiresAt = record.expires ? record.expires * 1000 : expiryFromToken(record.access);
  if (expiresAt !== undefined && expiresAt <= Date.now()) {
    return { ok: false, source, expiresAt, reason: "token expired" };
  }
  return { ok: true, source, ...(expiresAt !== undefined && { expiresAt }) };
}

/**
 * Assert a usable Copilot token exists. Throws fast with the refresh remedy
 * when missing/expired so live flows never hang waiting on auth.
 */
export function requireCopilotAuth(): CopilotAuthStatus {
  const status = getCopilotAuthStatus();
  if (!status.ok) {
    throw new Error(
      `[outside-in] Copilot auth precondition failed (${status.reason ?? "unknown"}; source=${status.source}). ${REFRESH_REMEDY}`,
    );
  }
  return status;
}
