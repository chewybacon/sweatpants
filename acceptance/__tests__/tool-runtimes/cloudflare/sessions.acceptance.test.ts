// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { run } from "effection";
import { createCloudflareSessionResources } from "@sweatpants/tool-runtime-cloudflare";
import type { ToolSessionNamespace } from "@sweatpants/tool-runtime-cloudflare";

let worker: Miniflare;
let sessions: ToolSessionNamespace;
let options: MiniflareOptions;
let persistence: string;
beforeAll(async () => {
  const bundle = await build({
    entryPoints: [new URL("./fixtures/session-worker.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["development"],
    external: ["cloudflare:workers", "node:*"],
  });
  persistence = await mkdtemp(join(tmpdir(), "cf-sessions-"));
  options = {
    resourcePersistencePath: persistence,
    workers: [
      {
        config: {
          name: "sessions",
          compatibilityDate: "2026-10-05",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "index.js",
            modules: { "index.js": { type: "esm", contents: bundle.outputFiles[0].text } },
          },
          exports: { Sessions: { type: "durable-object", storage: "sqlite" } },
          env: { SESSIONS: { type: "durable-object", worker: "sessions", exportName: "Sessions" } },
        },
      },
    ],
  };
  worker = new Miniflare(options);
  await worker.ready;
  sessions = {
    getByName(id) {
      async function invoke(method: string, ...args: unknown[]) {
        const response = await worker.dispatchFetch("http://sessions/rpc", {
          method: "POST",
          body: JSON.stringify({ id, method, args }),
        });
        const result = (await response.json()) as { error?: string; value: string };
        if (!response.ok) {
          throw new Error(result.error);
        }
        return result.value;
      }
      return {
        start: (wire) => invoke("start", wire),
        inspect: () => invoke("inspect"),
        next: (reader, cursor) => invoke("next", reader, cursor),
        cancelRead: async (reader) => {
          await invoke("cancelRead", reader);
        },
        resume: async (wire) => {
          await invoke("resume", wire);
        },
        close: async () => {
          await invoke("close");
        },
      };
    },
  };
});
afterAll(async () => {
  await worker?.dispose();
  await rm(persistence, { recursive: true, force: true });
});

async function start(id: string) {
  const rpc = sessions.getByName(id);
  await rpc.start(
    JSON.stringify({ invocationId: id, toolName: "two_turns", input: { label: "test" } }),
  );
  return rpc;
}

describe("Durable Object ordinary tool placement", () => {
  it("retains a generator across independent request scopes and readers", async () => {
    // Arrange
    const rpc = await start("multi");
    const first = JSON.parse(await rpc.next("first", 0)).value;
    expect(first).toMatchObject({ type: "elicit_request", message: "First" });

    // Act: resume from a fresh host request.
    // Reopening the factory models a fresh host/request; the DO retains the generator.
    const next = await run(function* () {
      const resource = yield* createCloudflareSessionResources(sessions).open("multi");
      expect(resource?.toolName).toBe("two_turns");
      yield* resource!.resume({
        kind: "elicit",
        requestId: first.elicitId,
        response: { action: "accept", content: { value: "one" } },
      });
      const reader = yield* resource!.projection.events(first.lsn);
      return yield* reader.next();
    });

    // Assert: the same generator reaches its second interaction.
    expect(next).toMatchObject({
      done: false,
      value: { type: "elicit_request", message: "Second" },
    });
    if (next.done || next.value.type !== "elicit_request") {
      throw new Error("Expected second elicit");
    }
    await rpc.resume(
      JSON.stringify({
        kind: "elicit",
        requestId: next.value.elicitId,
        response: { action: "accept", content: { value: "two" } },
      }),
    );
    const final = JSON.parse(await rpc.next("final", next.value.lsn));
    expect(final).toMatchObject({
      done: false,
      value: { type: "result", result: { label: "test", first: "accept", second: "accept" } },
    });
    expect(JSON.parse(await rpc.next("replay", 0)).value).toEqual(first);
    await rpc.close();
  });
  it("deduplicates starts and rejects conflicting input", async () => {
    // Arrange
    const rpc = await start("duplicate");
    const first = await rpc.next("reader", 0);

    // Act / Assert: repeating input reuses the session; different input conflicts.
    await start("duplicate");
    expect(await rpc.next("reader", 0)).toBe(first);
    await expect(
      rpc.start(
        JSON.stringify({
          invocationId: "duplicate",
          toolName: "two_turns",
          input: { label: "changed" },
        }),
      ),
    ).rejects.toThrow("invocation_conflict");
    await rpc.close();
  });
  it("cancels waiting reads and closes the generator", async () => {
    // Arrange
    const rpc = await start("cancel");
    const first = JSON.parse(await rpc.next("initial", 0)).value;

    // Act: cancel a blocked reader, then cancel the generator.
    const waiting = rpc.next("waiting", first.lsn);
    const rejected = expect(waiting).rejects.toThrow();
    await rpc.cancelRead("waiting");
    await rejected;
    await rpc.resume(JSON.stringify({ kind: "cancel", reason: "test" }));
    expect(JSON.parse(await rpc.next("terminal", first.lsn))).toMatchObject({
      value: { type: "cancelled", reason: "test" },
    });
    await rpc.close();
    await expect(rpc.inspect()).rejects.toThrow("tool_session_lost");
  });
  it("fails closed after workerd loss instead of rerunning ordinary effects", async () => {
    // Arrange
    const rpc = await start("evicted");
    expect(JSON.parse(await rpc.next("initial", 0)).value.type).toBe("elicit_request");

    // Act: destroy workerd, preserving only Durable Object storage.
    await worker.dispose();
    worker = new Miniflare(options);
    await worker.ready;

    // Assert: ordinary execution cannot be reconstructed from persistence.
    await expect(sessions.getByName("evicted").inspect()).rejects.toThrow("tool_session_lost");
    await expect(start("evicted")).rejects.toThrow("tool_session_lost");
  });
});
