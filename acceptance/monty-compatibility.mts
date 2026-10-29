/** Public package/build acceptance: valid repins must invalidate prior checkpoints. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run } from "effection";
import { createMontyKernel, montyIdentity } from "@sweatpants/flowmode-runtime-monty";
import { loadMontyModule } from "@sweatpants/flowmode-runtime-monty/node";
import type * as MontyApi from "@sweatpants/flowmode-runtime-monty";
import type * as MontyNode from "@sweatpants/flowmode-runtime-monty/node";
import { KernelCompatibilityError } from "@sweatpants/flowmode-runtime";

const original = fileURLToPath(new URL("../packages/flowmode-runtime-monty/", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "monty-compatibility-"));
const code = 'async def main():\n    return await operation("Reply")\n';
const program = { code, digest: "compatibility-acceptance", kernel: montyIdentity };
const snapshot = await run(function* () {
  const kernel = createMontyKernel(loadMontyModule);
  try {
    const state = yield* kernel.start(program, null);
    return yield* state.execution.capture();
  } finally {
    yield* kernel.close();
  }
});
const results: unknown[] = [];
try {
  for (const entry of [
    "unchanged",
    "monty.component.js",
    "monty.component.core.wasm",
    "monty.component.core2.wasm",
    "monty.component.core3.wasm",
    "monty.component.core4.wasm",
    "sourceCommit",
    "associationSha256",
  ]) {
    const directory = join(temporary, entry);
    await cp(original, directory, {
      recursive: true,
      filter: (path) => !path.includes("node_modules"),
    });
    await symlink(join(original, "node_modules"), join(directory, "node_modules"), "dir");
    const manifestPath = join(directory, "generated/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const build = (...args: string[]) =>
      execFileSync(process.execPath, [join(directory, "scripts/artifact.mjs"), ...args], {
        encoding: "utf8",
        stdio: "pipe",
      });
    if (entry !== "unchanged") {
      if (entry === "sourceCommit") {
        manifest.sourceCommit = "0".repeat(40);
      } else {
        const artifact = entry === "associationSha256" ? "queues-association.json" : entry;
        const path = join(directory, "generated", artifact);
        const bytes = await readFile(path);
        // A valid no-op custom section changes Wasm bytes without rebuilding it.
        // Wrapper comments / association whitespace similarly preserve behavior.
        const suffix = entry.endsWith(".wasm")
          ? Buffer.from([0, 2, 1, 120])
          : Buffer.from(entry.endsWith(".js") ? "\n// acceptance repin\n" : "\n");
        const repinned = Buffer.concat([bytes, suffix]);
        await writeFile(path, repinned);
        const hash = createHash("sha256").update(repinned).digest("hex");
        if (entry === "associationSha256") {
          manifest.associationSha256 = hash;
        } else {
          manifest.artifacts[entry] = hash;
        }
      }
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      assert.throws(() => build(), /Monty executable identity differs/);
      build("--generate");
    }
    build();
    const api: typeof MontyApi = await import(
      pathToFileURL(join(directory, "src/kernel.mjs")).href
    );
    const node: typeof MontyNode = await import(
      pathToFileURL(join(directory, "src/node.mjs")).href
    );
    const next = { ...program, kernel: api.montyIdentity };
    if (entry === "unchanged") {
      assert.deepEqual(api.montyIdentity, montyIdentity);
    } else {
      assert.notEqual(api.montyIdentity.version, montyIdentity.version);
      let loads = 0;
      const kernel = api.createMontyKernel(() => {
        loads++;
        throw Error("Must reject before loading Wasm");
      });
      try {
        await assert.rejects(
          run(function* () {
            return yield* kernel.restore(next, snapshot);
          }),
          KernelCompatibilityError,
        );
        assert.equal(loads, 0);
      } finally {
        await run(function* () {
          yield* kernel.close();
        });
      }
    }
    // Every fixture is executable and can restore its own identity in a fresh VM.
    await run(function* () {
      let kernel = api.createMontyKernel(node.loadMontyModule);
      try {
        let state = yield* kernel.start(next, null);
        const own = entry === "unchanged" ? snapshot : yield* state.execution.capture();
        yield* kernel.close();
        kernel = api.createMontyKernel(node.loadMontyModule);
        state = yield* kernel.restore(next, own);
        assert.deepEqual(yield* state.execution.capture(), own);
        assert.equal(state.boundary.kind, "suspended");
        if (state.boundary.kind !== "suspended") {
          throw Error("Expected waiting operation");
        }
        const operations = state.boundary.request.input as { operations: { id: number }[] };
        assert.deepEqual(
          yield* state.execution.resume(state.boundary.suspensionId, {
            kind: "value",
            value: { operationId: operations.operations[0].id, value: "restored" },
          }),
          { kind: "completed", value: "restored" },
        );
      } finally {
        yield* kernel.close();
      }
    });
    results.push({
      entry,
      identity: api.montyIdentity,
      staleCheckpointRejectedBeforeLoad: entry !== "unchanged",
      sameIdentityRestoreAndResume: true,
    });
  }
  console.log(JSON.stringify({ status: "PASS", results }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
