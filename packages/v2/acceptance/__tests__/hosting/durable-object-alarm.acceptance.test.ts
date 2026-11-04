import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

let code: string;
const directory = mkdtempSync(join(tmpdir(), "sweatpants-do-alarm-"));

function start() {
  return new Miniflare({
    resourcePersistencePath: directory,
    workers: [
      {
        config: {
          name: "conversations",
          compatibilityDate: "2026-10-05",
          manifest: {
            mainModule: "index.js",
            modules: { "index.js": { type: "esm", contents: code } },
          },
          exports: { Conversation: { type: "durable-object", storage: "sqlite" } },
          env: {
            CONVERSATIONS: {
              type: "durable-object",
              worker: "conversations",
              exportName: "Conversation",
            },
          },
        },
      },
    ],
  } as never);
}

beforeAll(async () => {
  const bundle = await build({
    entryPoints: [new URL("./fixtures/durable-object-alarm.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["development"],
    // Effection main() lazily imports node:process; it is never called here.
    external: ["cloudflare:workers", "node:process"],
  });
  code = bundle.outputFiles[0]!.text;
}, 30_000);

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe.each(["effect", "effection"])("Durable Object alarm under %s", (runtime) => {
  const id = `${runtime}-${crypto.randomUUID()}`;
  function url(path: string) {
    return `http://local${path}${path.includes("?") ? "&" : "?"}runtime=${runtime}&id=${id}`;
  }
  async function call(worker: Miniflare, path: string) {
    const response = await worker.dispatchFetch(url(path));
    const body = await response.text();
    if (!response.ok) {
      throw new Error(body);
    }
    return JSON.parse(body) as Record<string, unknown>;
  }
  async function until(worker: Miniflare, done: (state: Record<string, unknown>) => boolean) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await call(worker, "/read");
      if (done(state)) {
        return state;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Program did not reach the expected state");
  }
  async function drain(response: Response) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const item = await reader.read();
      if (item.done) {
        return text.split("\n").filter(Boolean);
      }
      text += decoder.decode(item.value, { stream: true });
    }
  }

  it("advances from an alarm with no client, streams live frames, and resumes after restart", async () => {
    let worker = start();
    try {
      // Admission returns before any work runs; the alarm advances the program.
      expect(await call(worker, "/admit?input=research")).toEqual({ accepted: true });
      const events = await worker.dispatchFetch(url("/events"));
      expect(events.status).toBe(200);
      const frames = await drain(events as unknown as Response);
      expect(
        frames
          .filter((frame) => frame.startsWith("delta:"))
          .join("")
          .replaceAll("delta:", ""),
      ).toBe("finding");
      expect(frames.at(-1)).toBe("state:waiting");
      expect(await until(worker, (state) => state.waiting === true)).toMatchObject({
        status: "running",
        deliveries: 1,
      });
    } finally {
      await worker.dispose();
    }
    worker = start();
    try {
      // New workerd, persisted storage, no live buffer: the journal is the authority.
      expect(await call(worker, "/read")).toMatchObject({
        status: "running",
        waiting: true,
        deliveries: 1,
      });
      expect(await call(worker, "/answer?value=yes")).toEqual({ accepted: true });
      // Nobody reads events here; the alarm still drives the program to completion.
      expect(await until(worker, (state) => state.status === "completed")).toEqual({
        status: "completed",
        waiting: false,
        value: "finding:yes",
        deliveries: 1,
      });
    } finally {
      await worker.dispose();
    }
  });

  it("a recovered retry emits through a fresh buffer while old readers retain the failure", async () => {
    const worker = start();
    try {
      expect(await call(worker, "/frame-lifecycle?scenario=retry")).toEqual({
        first: { error: "Error: transient" },
        failure: "Error: transient",
        frame: { done: false, value: "recovered" },
        end: { done: true },
        runs: 2,
        scheduled: 1,
      });
    } finally {
      await worker.dispose();
    }
  });

  it("coalesced wakes preserve readers attached before the second wake", async () => {
    const worker = start();
    try {
      expect(await call(worker, "/frame-lifecycle?scenario=duplicate")).toEqual({
        first: { value: { done: false, value: "recovered" } },
        terminal: { done: true },
        frame: { done: false, value: "recovered" },
        end: { done: true },
        runs: 1,
        scheduled: 2,
      });
    } finally {
      await worker.dispose();
    }
  });

  it("alarm middleware traces each run and stops retrying after the limit", async () => {
    const failing = `${id}-failing`;
    const worker = start();
    async function at(path: string) {
      const response = await worker.dispatchFetch(
        `http://local${path}${path.includes("?") ? "&" : "?"}runtime=${runtime}&id=${failing}`,
      );
      return (await response.json()) as unknown;
    }
    try {
      await at("/fail");
      let alarms: { retry: number; outcome: string; error: string | null }[] = [];
      for (let attempt = 0; attempt < 400; attempt++) {
        alarms = (await at("/alarms")) as typeof alarms;
        if (alarms.some((entry) => entry.outcome === "exhausted")) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // First failure rethrows (Cloudflare retries); the retry hits the limit and ends.
      expect(alarms).toEqual([
        { retry: 0, outcome: "failed", error: null },
        { retry: 1, outcome: "failed", error: null },
        { retry: 1, outcome: "exhausted", error: "Error: dependency unavailable" },
      ]);
      expect(await at("/read")).toMatchObject({ deliveries: 0 });
    } finally {
      await worker.dispose();
    }
  }, 20_000);
});
