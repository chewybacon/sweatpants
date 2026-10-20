import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomFillSync } from "node:crypto";
import { test } from "node:test";

// Mechanical ABI transport only. No instance or guest handle survives a call.
async function runPhase(module: WebAssembly.Module, phase: number, snapshot?: string) {
  const instance: WebAssembly.Instance = await WebAssembly.instantiate(module, {
    host: {
      random_fill(pointer: number, length: number) {
        const memory = instance.exports.memory as WebAssembly.Memory;
        randomFillSync(new Uint8Array(memory.buffer, pointer, length));
      },
    },
  });
  const memory = instance.exports.memory as WebAssembly.Memory;
  const allocate = instance.exports.allocate as (length: number) => number;
  const execute = instance.exports.execute as (pointer: number, length: number) => number;
  const outputLength = instance.exports.output_len as () => number;
  const input = new TextEncoder().encode(JSON.stringify({ phase, snapshot }));
  const pointer = allocate(input.length);
  new Uint8Array(memory.buffer, pointer, input.length).set(input);
  const output = execute(pointer, input.length);
  return JSON.parse(
    new TextDecoder().decode(new Uint8Array(memory.buffer, output, outputLength())),
  );
}

test("Lua task stacks preserve shared captures through two fresh Wasm instance restores", async () => {
  const bytes = await readFile(
    new URL(
      "../lua/target/wasm32-unknown-unknown/release/workflow_scoped_checkpoint_probe.wasm",
      import.meta.url,
    ),
  );
  const module = await WebAssembly.compile(bytes);
  const initial = await runPhase(module, 0);
  assert.equal(typeof initial, "string");
  assert.equal(JSON.parse(initial).threads.length, 3);
  // Rust assertions check the restored frontier before advancing either child.
  const settled = await runPhase(module, 1, initial);
  assert.equal(typeof settled, "string");
  assert.notEqual(settled, initial);
  // The parent observes both children's mutations after another fresh restore.
  assert.equal(await runPhase(module, 2, settled), 1111);
});
