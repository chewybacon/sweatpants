import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

export const YO_CHAT_AUTH_PROVIDERS = ["github-copilot", "openai-codex", "opencode"] as const;

export type YoChatAuthProvider = (typeof YO_CHAT_AUTH_PROVIDERS)[number];

export interface StoredModelSelection {
  readonly provider: YoChatAuthProvider;
  readonly id: string;
}

interface AuthFile {
  readonly version: 1;
  readonly selected?: StoredModelSelection;
  readonly credentials: Record<string, Credential>;
}

const DEFAULT_MODELS: Readonly<Record<YoChatAuthProvider, string>> = {
  "github-copilot": "claude-sonnet-4.6",
  "openai-codex": "gpt-5.5",
  opencode: "gpt-5.5",
};

/** Resolves to a repository-local, git-ignored credential file by default. */
export function sweatpantsAuthFile(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["YO_CHAT_MODEL_AUTH_FILE"]?.trim();
  return configured || resolve(workspaceRoot(), ".sweatpants", "auth.json");
}

export function isYoChatAuthProvider(value: string): value is YoChatAuthProvider {
  return (YO_CHAT_AUTH_PROVIDERS as readonly string[]).includes(value);
}

export function defaultModelForProvider(provider: YoChatAuthProvider): string {
  return DEFAULT_MODELS[provider];
}

/** Reads the selected profile without exposing any stored credential. */
export function readStoredModelSelection(
  path = sweatpantsAuthFile(),
): StoredModelSelection | undefined {
  return readAuthFile(path).selected;
}

export function selectStoredModel(
  selection: StoredModelSelection,
  path = sweatpantsAuthFile(),
): void {
  assertSelection(selection);
  const current = readAuthFile(path);
  writeAuthFile(path, { ...current, selected: { ...selection } });
}

export function clearStoredModelSelection(path = sweatpantsAuthFile()): void {
  const current = readAuthFile(path);
  if (current.selected === undefined) return;
  const { selected: _selected, ...withoutSelection } = current;
  writeAuthFile(path, withoutSelection);
}

/**
 * A small persistent CredentialStore for pi-ai. Every mutation rereads and
 * atomically rewrites the file so OAuth refreshes survive process restarts.
 */
export class FileCredentialStore implements CredentialStore {
  #chains = new Map<string, Promise<void>>();

  constructor(readonly path = sweatpantsAuthFile()) {}

  async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
    return cloneCredential(readAuthFile(this.path).credentials[providerId]);
  }

  async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return Object.entries(readAuthFile(this.path).credentials)
      .filter(([, credential]) => credential !== undefined)
      .map(([providerId, credential]) => ({ providerId, type: credential.type }))
      .sort((left, right) => left.providerId.localeCompare(right.providerId));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return this.enqueue(providerId, async () => {
      options?.signal?.throwIfAborted();
      const current = readAuthFile(this.path);
      const next = await fn(cloneCredential(current.credentials[providerId]));
      options?.signal?.throwIfAborted();
      if (next === undefined) return cloneCredential(current.credentials[providerId]);
      writeAuthFile(this.path, {
        ...current,
        credentials: { ...current.credentials, [providerId]: cloneCredential(next)! },
      });
      return cloneCredential(next);
    });
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    await this.enqueue(providerId, async () => {
      const current = readAuthFile(this.path);
      if (!(providerId in current.credentials)) return;
      const credentials = { ...current.credentials };
      delete credentials[providerId];
      const next: AuthFile = { ...current, credentials };
      if (next.selected?.provider === providerId) {
        const { selected: _selected, ...withoutSelection } = next;
        writeAuthFile(this.path, withoutSelection);
      } else {
        writeAuthFile(this.path, next);
      }
    });
  }

  private async enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(providerId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    const chain = previous.then(() => current);
    this.#chains.set(providerId, chain);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.#chains.get(providerId) === chain) this.#chains.delete(providerId);
    }
  }
}

export function removeAuthFile(path = sweatpantsAuthFile()): void {
  if (existsSync(path)) rmSync(path);
}

function workspaceRoot(): string {
  let directory = process.cwd();
  while (true) {
    if (existsSync(resolve(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return process.cwd();
    directory = parent;
  }
}

function readAuthFile(path: string): AuthFile {
  if (!existsSync(path)) return { version: 1, credentials: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse model auth file ${path}: ${message(error)}`);
  }
  if (!isRecord(parsed) || parsed["version"] !== 1 || !isRecord(parsed["credentials"])) {
    throw new Error(`Invalid model auth file ${path}`);
  }
  const credentials: Record<string, Credential> = {};
  for (const [providerId, credential] of Object.entries(parsed["credentials"])) {
    if (!isCredential(credential))
      throw new Error(`Invalid credential for ${providerId} in ${path}`);
    credentials[providerId] = credential;
  }
  const selected = parsed["selected"];
  if (selected !== undefined && !isSelection(selected)) {
    throw new Error(`Invalid selected model in ${path}`);
  }
  return {
    version: 1,
    ...(selected === undefined ? {} : { selected }),
    credentials,
  };
}

function writeAuthFile(path: string, state: AuthFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

function assertSelection(selection: StoredModelSelection): void {
  if (!isYoChatAuthProvider(selection.provider) || !selection.id.trim()) {
    throw new Error("Selected model must name a supported provider and non-empty model id");
  }
}

function isSelection(value: unknown): value is StoredModelSelection {
  return (
    isRecord(value) &&
    typeof value["provider"] === "string" &&
    isYoChatAuthProvider(value["provider"]) &&
    typeof value["id"] === "string" &&
    value["id"].trim().length > 0
  );
}

function isCredential(value: unknown): value is Credential {
  if (!isRecord(value)) return false;
  if (value["type"] === "api_key") {
    return value["key"] === undefined || typeof value["key"] === "string";
  }
  return (
    value["type"] === "oauth" &&
    typeof value["access"] === "string" &&
    typeof value["refresh"] === "string" &&
    typeof value["expires"] === "number"
  );
}

function cloneCredential(credential: Credential | undefined): Credential | undefined {
  return credential === undefined ? undefined : structuredClone(credential);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
