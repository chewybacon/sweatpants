import { createRequire } from "node:module";
import { connectHoot } from "../../operative.mjs";
// Resolve the worker dependency from its owning workspace package.
const { workerMain } = createRequire(
  new URL("../../../../../packages/tool-runtime-local/package.json", import.meta.url),
)("@effectionx/worker");

await workerMain(function* ({ messages }) {
  const connection = yield* connectHoot();
  yield* messages.forEach(function* (command) {
    try {
      return yield* connection.exchange(command);
    } catch (error) {
      return { kind: "rejected", message: error.message };
    }
  });
});
