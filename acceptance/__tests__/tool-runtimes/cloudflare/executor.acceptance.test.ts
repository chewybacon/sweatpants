// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { run, scoped } from "effection";
import { createDurableToolRegistry } from "@sweatpants/durable-execution";
import {
  DURABLE_DRIVER_FIXTURE_TOOLS,
  runDurableDriverRecoveryFixture,
  runDurableDriverCancellationFixture,
} from "@sweatpants/journal-authority/testing";
import {
  createCloudflareProgramDriver,
  type ToolExecutorEntrypoint,
  type ToolExecutorRpc,
} from "@sweatpants/tool-runtime-cloudflare";

describe.each(["dynamic", "do"])("%s program execution", (placement) => {
  let worker: Miniflare;
  const targets: ToolExecutorRpc[] = [];
  const entrypoint: ToolExecutorEntrypoint = {
    async createExecutor() {
      const host = await worker.getWorker();
      const proxy = await (
        host as unknown as {
          createExecutor(): Promise<
            Omit<ToolExecutorRpc, typeof Symbol.dispose> & { dispose(): Promise<void> }
          >;
        }
      ).createExecutor();
      const target: ToolExecutorRpc = {
        attach: (request) => proxy.attach(request),
        step: (id, command) => proxy.step(id, command),
        shutdown: (id, reason) => proxy.shutdown(id, reason),
        [Symbol.dispose]: () => proxy.dispose(),
      };
      targets.push(target);
      return target;
    },
  };

  beforeAll(async () => {
    const bundle = await build({
      entryPoints: [new URL("./fixtures/worker.ts", import.meta.url).pathname],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      conditions: ["development"],
      external: ["cloudflare:workers", "node:*"],
    });
    const host = await build({
      entryPoints: [new URL("./fixtures/host.ts", import.meta.url).pathname],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      external: ["cloudflare:workers", "node:*"],
      conditions: ["development"],
    });
    worker = new Miniflare({
      workers: [
        {
          config: {
            name: "executor",
            compatibilityDate: "2026-10-05",
            compatibilityFlags: ["nodejs_compat"],
            manifest: {
              mainModule: "index.js",
              modules: { "index.js": { type: "esm", contents: host.outputFiles[0].text } },
            },
            exports: { Executor: { type: "durable-object", storage: "sqlite" } },
            env: {
              EXECUTORS: { type: "durable-object", worker: "executor", exportName: "Executor" },
              PLACEMENT: { type: "text", value: placement },
              LOADER: { type: "worker-loader" },
              CODE: { type: "text", value: bundle.outputFiles[0].text },
            },
          },
        },
      ],
    });
    await worker.ready;
  });
  afterAll(async () => {
    await worker?.dispose();
  });

  describe("request-scoped program execution", () => {
    it("pulls a request-scoped RPC target through replay and completion inside workerd", async () => {
      // Act: cross the request boundary into the real workerd executor.
      const response = await worker.dispatchFetch("http://executor/recovery");

      // Assert
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        firstRun: { state: "parked", reason: "elicit" },
        secondRun: { state: "completed", value: "hello:true" },
        effectExecutions: 1,
        attachmentCount: 2,
      });
    });
    it("closes the remote generator before disposing the native attachment stub", async () => {
      // Act: cross the request boundary into the real workerd executor.
      const response = await worker.dispatchFetch("http://executor/cleanup");

      // Assert
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "stale_program_capability" },
      });
    });
    it("reports malformed commands without breaking subsequent RPC calls", async () => {
      // Arrange
      const executor = await entrypoint.createExecutor();

      // Act / Assert: a malformed command must not poison the next RPC.
      expect(JSON.parse(await executor.attach("not json"))).toMatchObject({
        ok: false,
        error: { code: "executor_failed" },
      });
      expect(JSON.parse(await executor.shutdown("missing", "scope_exit"))).toEqual({ ok: true });
      await executor[Symbol.dispose]();
    });
    it("parks, replaces the executor, and replays without repeating a settled effect", async () => {
      // Arrange
      const before = targets.length;

      // Act: park, replace the executor, and resume through the public driver.
      const evidence = await run(() =>
        runDurableDriverRecoveryFixture({
          driverKind: "cloudflare",
          useActivationLease: true,
          createDriver: (registry) => createCloudflareProgramDriver(entrypoint, registry),
        }),
      );

      expect(evidence.firstRun).toMatchObject({ state: "parked", reason: "elicit" });
      expect(evidence.secondRun).toEqual({ state: "completed", value: "hello:true" });
      expect(evidence.effectExecutions).toBe(1);
      expect(evidence.attachmentWasProcessless).toBe(true);
      expect(evidence.attachmentCount).toBe(2);
      expect(new Set(targets.slice(before)).size).toBe(2);
    });

    it("delivers durable cancellation and runs recorded cleanup after a park", async () => {
      const evidence = await run(() =>
        runDurableDriverCancellationFixture({
          driverKind: "cloudflare",
          useActivationLease: true,
          createDriver: (registry) => createCloudflareProgramDriver(entrypoint, registry),
        }),
      );
      expect(evidence.secondRun).toEqual({ state: "cancelled" });
      expect(evidence.cleanupExecutions).toBe(1);
      expect(evidence.cancellationCatches).toBe(1);
    });

    it("releases an abandoned attachment with its owning scope and rejects stale steps", async () => {
      // Arrange
      const tool = DURABLE_DRIVER_FIXTURE_TOOLS[0];
      await run(function* () {
        const driver = createCloudflareProgramDriver(entrypoint, createDurableToolRegistry([tool]));
        // Act: let the attachment owner finish before using its capability.
        const attachment = yield* scoped(() =>
          driver.attach({
            sessionId: "cleanup",
            taskId: "root",
            executionEpoch: 1,
            input: "hello",
            route: { driverKind: "cloudflare" },
            program: {
              id: tool.manifest.programId,
              version: tool.manifest.version,
              digest: tool.manifest.digest,
            },
          }),
        );
        let failure: unknown;
        try {
          yield* driver.step(attachment, { type: "start", input: "hello" });
        } catch (error) {
          failure = error;
        }
        // Assert
        expect(failure).toMatchObject({ code: "stale_program_capability" });
      });
    });
  });
});
