/**
 * Tier B server lifecycle fixture (design R3 / Decision 3 / Q4).
 *
 * Boots the ACTUAL yo-chat app server ONCE per run (or reuses an already-running
 * server when requested) so the tier exercises the real vite `nodeWorkerPlugin`
 * / `?modulePath` worker bundling and SSR wiring. Intended to be driven from a
 * vitest `globalSetup`, but also exposes a lazy singleton fallback for running a
 * single flow file directly.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MAX_CAPTURED_LOG_CHARS = 20_000;

export interface ServerHandle {
  url: string;
  reused: boolean;
  close(): Promise<void>;
}

export interface BootServerOptions {
  port?: number;
  /** Reuse an already-running server at the target URL instead of spawning. */
  reuseExisting?: boolean;
  /** Readiness timeout in ms. */
  timeoutMs?: number;
  /** Extra env for the spawned server. */
  env?: Record<string, string>;
}

function defaultPort(): number {
  return Number.parseInt(process.env["OUTSIDE_IN_SERVER_PORT"] ?? "8123", 10);
}

/**
 * Build the spawned server's env from the current env, but scrub every Vitest
 * marker. CRITICAL: the app's vite config gates OUT `nodeWorkerPlugin` when
 * `VITEST` is set, so a server booted with those vars would skip the exact
 * `?modulePath` worker bundling Tier B exists to exercise (and crashes with
 * `self is not defined` in the worker). Tier B must boot a genuine dev server.
 */
function scrubbedServerEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }
    if (key === "VITEST" || key.startsWith("VITEST_")) {
      continue;
    }
    env[key] = value;
  }
  return { ...env, ...overrides };
}

function captureOutput(child: ChildProcess): () => string {
  let captured = "";
  const passthrough = process.env["OUTSIDE_IN_SERVER_LOGS"] === "1";

  function append(text: string): void {
    captured += text;
    if (captured.length > MAX_CAPTURED_LOG_CHARS) {
      captured = captured.slice(-MAX_CAPTURED_LOG_CHARS);
    }
  }

  function attach(stream: Readable | null, target: NodeJS.WriteStream): void {
    stream?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      if (passthrough) {
        target.write(text);
      }
      append(text);
    });
  }

  attach(child.stdout, process.stdout);
  attach(child.stderr, process.stderr);

  return () => {
    const output = captured.trim();
    return output.length > 0
      ? `\n\n--- captured tier-b server output ---\n${output}\n--- end tier-b server output ---`
      : "";
  };
}

async function isResponding(url: string, timeoutMs = 750): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status > 0;
  } catch {
    return false;
  }
}

async function waitForReady(url: string, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    if (await isResponding(url)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`[outside-in:tier-b] server did not become ready at ${url}`);
}

/**
 * Boot (or reuse) the yo-chat server. The returned `close()` is a no-op when an
 * existing server was reused, so reuse never kills a developer's dev server.
 */
export async function bootServer(options: BootServerOptions = {}): Promise<ServerHandle> {
  const port = options.port ?? defaultPort();
  const url = `http://127.0.0.1:${port}`;
  const reuseExisting = options.reuseExisting ?? process.env["OUTSIDE_IN_REUSE_SERVER"] === "1";
  const timeoutMs = options.timeoutMs ?? 45_000;

  if (await isResponding(url)) {
    if (reuseExisting) {
      return { url, reused: true, close: async () => {} };
    }
    throw new Error(
      `[outside-in:tier-b] ${url} is already responding; set ` +
        `OUTSIDE_IN_REUSE_SERVER=1 to reuse it or OUTSIDE_IN_SERVER_PORT to choose another port`,
    );
  }

  const child = spawn(
    "pnpm",
    ["exec", "vite", "dev", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
    {
      cwd: APP_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: scrubbedServerEnv({
        NODE_ENV: "development",
        DEFAULT_CHAT_MODEL_PROVIDER: process.env["DEFAULT_CHAT_MODEL_PROVIDER"] ?? "github-copilot",
        DEFAULT_CHAT_MODEL_ID: process.env["DEFAULT_CHAT_MODEL_ID"] ?? "claude-sonnet-4.5",
        MCP_TOOL_RUNTIME: process.env["MCP_TOOL_RUNTIME"] ?? "local",
        ...options.env,
      }),
    },
  );
  const capturedOutput = captureOutput(child);

  const exited = new Promise<never>((_, reject) => {
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `[outside-in:tier-b] server exited early (code ${code}, signal ${signal})` +
            capturedOutput(),
        ),
      );
    });
    child.once("error", (error) => {
      reject(
        new Error(
          `[outside-in:tier-b] failed to start server: ${error.message}` + capturedOutput(),
        ),
      );
    });
  });

  try {
    await Promise.race([waitForReady(url, Date.now() + timeoutMs), exited]);
  } catch (error) {
    child.kill("SIGTERM");
    if (error instanceof Error && !error.message.includes("captured tier-b")) {
      throw new Error(error.message + capturedOutput(), { cause: error });
    }
    throw error;
  }

  return {
    url,
    reused: false,
    async close() {
      if (child.exitCode !== null) {
        return;
      }
      await new Promise<void>((resolveClose) => {
        child.once("exit", () => resolveClose());
        child.kill("SIGTERM");
        setTimeout(() => {
          child.kill("SIGKILL");
          resolveClose();
        }, 5000).unref();
      });
    },
  };
}

// -----------------------------------------------------------------------------
// Lazy singleton fallback (used when no globalSetup provided OUTSIDE_IN_SERVER_URL)
// -----------------------------------------------------------------------------

let singleton: Promise<ServerHandle> | null = null;

export function ensureSharedServer(): Promise<ServerHandle> {
  const provided = process.env["OUTSIDE_IN_SERVER_URL"];
  if (provided) {
    return Promise.resolve({ url: provided, reused: true, close: async () => {} });
  }
  if (!singleton) {
    singleton = bootServer();
  }
  return singleton;
}

export async function shutdownSharedServer(): Promise<void> {
  if (singleton) {
    const handle = await singleton;
    await handle.close();
    singleton = null;
  }
}
