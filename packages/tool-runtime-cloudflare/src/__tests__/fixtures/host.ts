import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
import { run, scoped, call } from "effection";
import { createDurableToolRegistry } from "@sweatpants/durable-execution";
import {
  DURABLE_DRIVER_FIXTURE_TOOLS,
  runDurableDriverRecoveryFixture,
} from "@sweatpants/journal-authority/testing";
import { createCloudflareProgramDriver } from "../../index.ts";
import type { ToolExecutorRpc } from "../../index.ts";
import type { ToolExecutorClass } from "../../executor.ts";
import { createToolExecutorObject } from "../../executor.ts";
import { toolsWithExecutionServices, installExecutionServices } from "./execution-setup.ts";
export const Executor = createToolExecutorObject({
  tools: toolsWithExecutionServices,
  setup: installExecutionServices,
});
export default class Host extends WorkerEntrypoint<{
  LOADER: WorkerLoader;
  CODE: string;
  EXECUTORS: DurableObjectNamespace<InstanceType<typeof Executor>>;
  PLACEMENT: string;
}> {
  private loadWorker() {
    if (this.env.PLACEMENT === "do") return this.env.EXECUTORS.getByName(crypto.randomUUID());
    return this.env.LOADER.load({
      compatibilityDate: "2026-10-05",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "executor.js",
      modules: { "executor.js": this.env.CODE },
      globalOutbound: null,
    }).getEntrypoint<InstanceType<ToolExecutorClass>>();
  }
  async createExecutor() {
    const target = await this.loadWorker().createExecutor();
    return new NodeProxy(target);
  }
  override async fetch(request: Request) {
    const worker = this.loadWorker();
    if (new URL(request.url).pathname === "/recovery") {
      return Response.json(
        await run(() =>
          runDurableDriverRecoveryFixture({
            driverKind: "cloudflare",
            useActivationLease: true,
            createDriver: (registry) => createCloudflareProgramDriver(worker, registry),
          }),
        ),
      );
    }
    // A duplicated stub keeps the remote object reachable after the driver's
    // own scope ends, so this observes generator cleanup rather than GC.
    const target = await worker.createExecutor();
    const probe = target.dup();
    try {
      const tool = DURABLE_DRIVER_FIXTURE_TOOLS[0];
      const evidence = await run(function* () {
        const driver = createCloudflareProgramDriver(
          {
            async createExecutor() {
              return target;
            },
          },
          createDurableToolRegistry([tool]),
        );
        const attachment = yield* scoped(() =>
          driver.attach({
            sessionId: "native-cleanup",
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
        return yield* call(() =>
          probe.step(attachment.attachmentId, JSON.stringify({ type: "start", input: "hello" })),
        );
      });
      return new Response(evidence);
    } finally {
      probe[Symbol.dispose]();
    }
  }
}

// Miniflare's Node proxy does not forward Symbol.dispose. Bridge it explicitly
// inside workerd, where the real RPC stub and its disposal live.
class NodeProxy extends RpcTarget {
  constructor(private target: ToolExecutorRpc) {
    super();
  }
  attach(request: string) {
    return this.target.attach(request);
  }
  step(id: string, command: string) {
    return this.target.step(id, command);
  }
  shutdown(id: string, reason: string) {
    return this.target.shutdown(id, reason);
  }
  dispose() {
    this.target[Symbol.dispose]();
  }
}
