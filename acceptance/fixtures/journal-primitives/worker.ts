import { runScenario } from "./scenario.ts";

const [engine, path, stopText = "-1", variant = "normal"] = process.argv.slice(2);
if (!path || (engine !== "candidate" && engine !== "reference" && engine !== "inspect")) {
  throw new Error("worker engine database [stop index]");
}
await runScenario({
  engine,
  path,
  stop: Number(stopText),
  variant,
  recoverPending: process.env.SEQUENCE_RECOVERY === "1",
  // Real abrupt exit: no generator unwinding or SQLite close at crash boundaries.
  interrupt: (status) => process.exit(status),
});
