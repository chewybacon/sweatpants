import { invoke } from "./native.mts";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { run, call } from "effection";
import { ANY_JSON_SCHEMA_DESCRIPTOR as schema } from "@sweatpants/durable-execution";
import { loadKernelProgram } from "@sweatpants/flowmode-backend/program";
import { createLuaRuntime } from "./kernel.mts";
import { createLuaProgramBundle } from "./program.mts";

const mode = process.argv[2] ?? "approve";
if (!["approve", "decline", "throw", "cancel", "cancel-cleanup"].includes(mode)) {
  throw Error("Use approve, decline, throw, cancel, or cancel-cleanup");
}
const source = await readFile(new URL("../examples/approval.lua", import.meta.url), "utf8");
const bundle = createLuaProgramBundle(source, {
  programId: "lua-approval-demo",
  version: "1",
  inputSchema: schema,
  outputSchema: schema,
  effects: {},
  elicits: Object.fromEntries(
    ["prefix", "approval", "cleanup"].map((name) => [name, { response: schema }]),
  ),
  capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
});
const runtime = createLuaRuntime(invoke);
const directory = new URL(
  `../../../.artifacts/flowmode-runtime-lua/${mode}-${Date.now()}/`,
  import.meta.url,
);
await mkdir(directory, { recursive: true });
const trace: unknown[] = [];
await run(function* () {
  let kernel = yield* runtime.createKernel();
  try {
    let live = yield* kernel.start(loadKernelProgram(bundle, bundle.artifact.digest), {
      title: "Review",
      metadata: null,
    });
    let cancellationSent = false;
    for (let step = 0; step < 8; step++) {
      trace.push({ event: "boundary", boundary: live.boundary });
      if (live.boundary.kind !== "suspended") {
        break;
      }
      const snapshot = yield* live.execution.capture();
      // Actual JSON round-trip: the new instance receives no live VM or JS handles.
      const bytes = JSON.stringify(snapshot);
      yield* call(() => writeFile(new URL(`${step}.json`, directory), bytes));
      yield* kernel.close();
      kernel = yield* runtime.createKernel();
      live = yield* kernel.restore(
        loadKernelProgram(bundle, bundle.artifact.digest),
        JSON.parse(bytes),
      );
      trace.push({ event: "restored", bytes: Buffer.byteLength(bytes), boundary: live.boundary });
      if (live.boundary.kind !== "suspended") {
        break;
      }
      const site = live.boundary.request.site;
      if (
        !cancellationSent &&
        ((mode === "cancel" && site === "approval") ||
          (mode === "cancel-cleanup" && site === "cleanup"))
      ) {
        cancellationSent = true;
        const boundary = yield* live.execution.cancel("demo cancellation");
        // Repeated cancellation addresses the same pending cleanup, never resumes it.
        const repeated = yield* live.execution.cancel("second cancellation");
        trace.push({ event: "repeated-cancel", first: boundary, repeated });
        live = { execution: live.execution, boundary: repeated };
      } else {
        const boundary = yield* live.execution.resume(
          live.boundary.suspensionId,
          mode === "throw" && site === "approval"
            ? { kind: "throw", value: "host rejected approval" }
            : { kind: "value", value: site === "approval" ? mode !== "decline" : null },
        );
        live = { execution: live.execution, boundary };
      }
    }
  } finally {
    yield* kernel.close();
  }
});
await writeFile(new URL("trace.json", directory), JSON.stringify(trace, null, 2));
console.log(JSON.stringify({ mode, trace, evidence: directory.pathname }, null, 2));
