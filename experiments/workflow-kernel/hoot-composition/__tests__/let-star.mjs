import assert from "node:assert/strict";
import { loadMachine } from "../machine.mjs";

// Sequential initializers see earlier bindings; shadowing does not rewrite
// the environment captured by an earlier closure. Resume crosses an initializer.
const source = `(let* ((x 2) (read-x (lambda () x)) (x (+ x 3))
                     (reply (yield-at "answer" (list "elicit" "answer")))
                     (total (+ x reply)))
                  (list (read-x) x total))`;
let machine = await loadMachine();
assert.equal(machine.start(source).kind, "effect");
const checkpoint = machine.capture();
machine = await loadMachine();
assert.equal(machine.restore(source, checkpoint).kind, "effect");
assert.deepEqual(machine.resume(7).value, [2, 5, 12]);
machine = await loadMachine();
assert.equal(machine.start("(let* () 42)").value, 42);
console.log("let*: sequential bindings, shadowing, empty bindings and restore passed");
