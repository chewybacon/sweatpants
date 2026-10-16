import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Install before dynamic imports so even a transitive reference-backend dependency fails.
registerHooks({
    resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context);
        assert.ok(
            !/\/(compiled-frames|compiled-finally|continuation-compiler)\//.test(resolved.url),
            `Hoot execution imported a reference backend: ${resolved.url}`,
        );
        return resolved;
    },
});
const { source } = await import("../fixture.mjs");
const { loadMachine } = await import("../machine.mjs");
let machine = await loadMachine();
assert.deepEqual(machine.start(source).value, ["elicit", "reserve"]);
const waiting = machine.resume({ action: "accept", content: "hold-17" });
assert.deepEqual(waiting.value, ["elicit", "approve", "hold-17"]);
const snapshot = machine.capture();
machine = null;
machine = await loadMachine();
assert.deepEqual(machine.restore(source, snapshot), waiting);
assert.equal(machine.capture(), snapshot);
assert.deepEqual(machine.resume({ action: "accept", content: "approved" }).value, [
    "elicit",
    "release",
    "hold-17",
]);
assert.deepEqual(machine.resume({ action: "accept", content: "released" }), {
    kind: "returned",
    site: "",
    value: "Caller received: approved",
});
console.log(
    "PASS emission, Hoot composition and fresh-instance recovery without any bytecode backend imports",
);
