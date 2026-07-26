import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

interface OAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

interface AuthRecord extends OAuthCredentials {
  type?: unknown;
}

interface AuthFile {
  ["github-copilot"]?: AuthRecord;
}

interface TokenInfo {
  token: string;
  source: string;
  authFile?: string;
  record?: AuthRecord;
  fields: Record<string, string>;
  expiresAt?: Date;
  proxyEndpoint?: string;
  baseUrl?: string;
}

const providerId = "github-copilot";
const defaultSweatpantsAuthFile = `${homedir()}/.sweatpants/auth.json`;
const envTokenName = "COPILOT_GITHUB_TOKEN";
const envSweatpantsAuthFileName = "SWEATPANTS_AUTH_FILE";

function usage(): never {
  console.log(`GitHub Copilot auth helper

Usage:
  pnpm copilot:auth                  Show redacted auth status
  pnpm copilot:auth:login            Run GitHub Copilot device auth and save to ~/.sweatpants/auth.json
  pnpm copilot:auth:refresh          Refresh the stored Sweatpants token
  pnpm copilot:auth:logout           Delete the stored Sweatpants token
  pnpm copilot:auth:env              Print shell exports for the current token
  pnpm copilot:auth:sync             Write apps/yo-chat/.env.local

Direct commands:
  pnpm tsx scripts/copilot-auth.ts status
  pnpm tsx scripts/copilot-auth.ts login
  pnpm tsx scripts/copilot-auth.ts refresh
  pnpm tsx scripts/copilot-auth.ts logout
  pnpm tsx scripts/copilot-auth.ts env
  pnpm tsx scripts/copilot-auth.ts write-env [path]

Token lookup order:
  1. ${envTokenName}
  2. ${envSweatpantsAuthFileName} or ${defaultSweatpantsAuthFile}
`);
  process.exit(0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAuthFile(path: string): AuthFile | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(parsed) ? (parsed as AuthFile) : null;
  } catch (error) {
    throw new Error(
      `Unable to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeAuthFile(path: string, auth: AuthFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readAuthRecord(path: string): AuthRecord | undefined {
  const access = readAuthFile(path)?.[providerId];
  return isRecord(access) ? (access as AuthRecord) : undefined;
}

function parseTokenFields(token: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of token.split(";")) {
    const [rawKey, ...rest] = part.split("=");
    const key = rawKey?.trim();
    if (!key || rest.length === 0) {
      continue;
    }
    fields[key] = rest.join("=").trim();
  }
  return fields;
}

function parseExpiryFromToken(fields: Record<string, string>): Date | undefined {
  const raw = fields["exp"] ?? fields["expires_at"] ?? fields["expiresAt"];
  if (!raw) {
    return undefined;
  }
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return epochToDate(numeric);
}

function epochToDate(value: number | undefined): Date | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const millis = value! > 10_000_000_000 ? value! : value! * 1000;
  return new Date(millis);
}

function normalizeRecord(record: AuthRecord): AuthRecord {
  return { ...record, type: "oauth" };
}

function copilotBaseUrlFromAccessToken(token: string): string | undefined {
  const proxyEndpoint = parseTokenFields(token)["proxy-ep"];
  return proxyEndpoint ? `https://${proxyEndpoint.replace(/^proxy\./, "api.")}` : undefined;
}

async function loadCopilotOAuth(): Promise<{
  loginGitHubCopilot: (options: {
    onDeviceCode: (info: {
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }) => void;
    onPrompt: (prompt: {
      message: string;
      placeholder?: string;
      allowEmpty?: boolean;
    }) => Promise<string>;
    onProgress?: (message: string) => void;
    signal?: AbortSignal;
  }) => Promise<OAuthCredentials>;
  refreshGitHubCopilotToken: (
    refreshToken: string,
    enterpriseDomain?: string,
  ) => Promise<OAuthCredentials>;
}> {
  return (await import("@earendil-works/pi-ai/oauth")) as unknown as Awaited<
    ReturnType<typeof loadCopilotOAuth>
  >;
}

function tokenInfoFromRecord(
  source: string,
  authFile: string,
  record: AuthRecord,
): TokenInfo | null {
  if (typeof record.access !== "string" || record.access.trim().length === 0) {
    return null;
  }
  const token = record.access.trim();
  const fields = parseTokenFields(token);
  const proxyEndpoint = fields["proxy-ep"];
  return {
    token,
    source,
    authFile,
    record,
    fields,
    expiresAt:
      epochToDate(typeof record.expires === "number" ? record.expires : undefined) ??
      parseExpiryFromToken(fields),
    proxyEndpoint,
    baseUrl: copilotBaseUrlFromAccessToken(token),
  };
}

function sweatpantsAuthFile(): string {
  return process.env[envSweatpantsAuthFileName]?.trim() || defaultSweatpantsAuthFile;
}

function findToken(): TokenInfo | null {
  const envToken = process.env[envTokenName]?.trim();
  if (envToken) {
    const fields = parseTokenFields(envToken);
    const proxyEndpoint = fields["proxy-ep"];
    return {
      token: envToken,
      source: envTokenName,
      fields,
      expiresAt: parseExpiryFromToken(fields),
      proxyEndpoint,
      baseUrl: copilotBaseUrlFromAccessToken(envToken),
    };
  }

  const ownAuthFile = sweatpantsAuthFile();
  const ownRecord = readAuthRecord(ownAuthFile);
  if (ownRecord) {
    return tokenInfoFromRecord("sweatpants-auth-file", ownAuthFile, ownRecord);
  }

  return null;
}

function redactToken(token: string): string {
  if (token.length <= 16) {
    return "[redacted]";
  }
  return `${token.slice(0, 6)}…${token.slice(-6)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function requireToken(): TokenInfo {
  const info = findToken();
  if (info) {
    return info;
  }

  console.error("No GitHub Copilot auth token found.");
  console.error(`Checked ${envTokenName} and ${sweatpantsAuthFile()}`);
  console.error("Run pnpm copilot:auth:login or export COPILOT_GITHUB_TOKEN directly.");
  process.exit(1);
}

function formatExpiry(expiresAt: Date | undefined): string {
  if (!expiresAt) {
    return "unknown";
  }
  const remainingMs = expiresAt.getTime() - Date.now();
  const remainingMinutes = Math.round(remainingMs / 60_000);
  const suffix =
    remainingMs >= 0
      ? `${remainingMinutes} min remaining`
      : `${Math.abs(remainingMinutes)} min expired`;
  return `${expiresAt.toISOString()} (${suffix})`;
}

function status(): void {
  const info = requireToken();
  console.log("GitHub Copilot auth: OK");
  console.log(`source: ${info.source}`);
  if (info.authFile) {
    console.log(`auth file: ${info.authFile}`);
  }
  console.log(`token: ${redactToken(info.token)}`);
  console.log(`expires: ${formatExpiry(info.expiresAt)}`);
  console.log(`proxy endpoint: ${info.proxyEndpoint ?? "not present in token"}`);
  console.log(`base URL: ${info.baseUrl ?? "default provider base URL"}`);
  if (info.expiresAt && info.expiresAt.getTime() <= Date.now()) {
    console.error(
      "Token appears expired. Run pnpm copilot:auth:refresh or pnpm copilot:auth:login.",
    );
    process.exit(1);
  }
}

function env(): void {
  const info = requireToken();
  console.log(`export ${envTokenName}=${shellQuote(info.token)}`);
  if (info.authFile) {
    console.log(`export ${envSweatpantsAuthFileName}=${shellQuote(info.authFile)}`);
  }
}

function writeEnv(pathArg: string | undefined): void {
  const info = requireToken();
  const target = resolve(pathArg ?? "apps/yo-chat/.env.local");
  mkdirSync(dirname(target), { recursive: true });
  const lines = [
    "# Generated by pnpm copilot:auth:sync. Do not commit.",
    "DEFAULT_CHAT_MODEL_PROVIDER=github-copilot",
    `COPILOT_GITHUB_TOKEN=${info.token}`,
    ...(info.authFile && info.source === "sweatpants-auth-file"
      ? [`SWEATPANTS_AUTH_FILE=${info.authFile}`]
      : []),
    "",
  ];
  writeFileSync(target, lines.join("\n"), { mode: 0o600 });
  chmodSync(target, 0o600);
  console.log(`Wrote ${target}`);
  console.log(`Token source: ${info.source}; expires: ${formatExpiry(info.expiresAt)}`);
}

async function login(): Promise<void> {
  const authFile = sweatpantsAuthFile();
  const rl = createInterface({ input, output });
  try {
    const { loginGitHubCopilot } = await loadCopilotOAuth();
    const credentials = await loginGitHubCopilot({
      onDeviceCode(info) {
        console.log("GitHub Copilot device authorization required:");
        console.log(`  Open: ${info.verificationUri}`);
        console.log(`  Code: ${info.userCode}`);
        if (info.expiresInSeconds) {
          console.log(`  Expires in: ${info.expiresInSeconds}s`);
        }
      },
      async onPrompt(prompt) {
        const suffix = prompt.placeholder ? ` (${prompt.placeholder})` : "";
        const answer = await rl.question(`${prompt.message}${suffix}: `);
        return answer || "";
      },
      onProgress(message) {
        console.log(message);
      },
    });
    writeAuthFile(authFile, { [providerId]: normalizeRecord(credentials) });
    console.log(`Saved GitHub Copilot credentials to ${authFile}`);
    status();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("401") || message.includes("Bad credentials")) {
      console.error(
        "GitHub accepted the device flow, but the Copilot token exchange failed with 401.",
      );
      console.error(
        "Verify the browser session used for the device code has an active Copilot entitlement/SSO authorization.",
      );
    }
    throw error;
  } finally {
    rl.close();
  }
}

async function refresh(): Promise<void> {
  const authFile = sweatpantsAuthFile();
  const record = readAuthRecord(authFile);
  if (!record?.refresh || typeof record.refresh !== "string") {
    console.error(`No refresh token found in ${authFile}. Run pnpm copilot:auth:login.`);
    process.exit(1);
  }
  const { refreshGitHubCopilotToken } = await loadCopilotOAuth();
  const refreshed = await refreshGitHubCopilotToken(record.refresh);
  writeAuthFile(authFile, { [providerId]: normalizeRecord(refreshed) });
  console.log(`Refreshed GitHub Copilot credentials in ${authFile}`);
  status();
}

function logout(): void {
  const authFile = sweatpantsAuthFile();
  if (!existsSync(authFile)) {
    console.log(`No Sweatpants auth file found at ${authFile}`);
    return;
  }
  const auth = readAuthFile(authFile) ?? {};
  delete auth[providerId];
  if (Object.keys(auth).length === 0) {
    rmSync(authFile);
    console.log(`Deleted ${authFile}`);
    return;
  }
  writeAuthFile(authFile, auth);
  console.log(`Removed ${providerId} from ${authFile}`);
}

async function main(): Promise<void> {
  const [command = "status", maybePath] = process.argv.slice(2);

  switch (command) {
    case "status":
    case "check":
    case "doctor":
      status();
      break;
    case "login":
      await login();
      break;
    case "refresh":
      await refresh();
      break;
    case "logout":
      logout();
      break;
    case "env":
    case "export":
      env();
      break;
    case "write-env":
    case "sync":
      writeEnv(maybePath);
      break;
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      usage();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
