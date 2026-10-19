import fs from "node:fs";
import { loadBundle } from "./load.mjs";
import { create, recover, appendCommand, repair } from "../compiled-finally/journal.mjs";
const request = JSON.parse(fs.readFileSync(0, "utf8"));
const { artifact: a, schemas } = loadBundle(
    JSON.parse(fs.readFileSync(request.bundlePath, "utf8")),
  ),
  registry = { [a.id]: a };
let record = request.record ?? create(a, "artifact-proof", schemas, request.input);
if (request.command) {
  record = appendCommand(record, registry, request.command, schemas);
}
record = repair(record, registry, schemas);
const ctx = recover(record, registry, schemas);
console.log(
  JSON.stringify({ record, pending: ctx.pending, outcome: ctx.state.outcome, pid: process.pid }),
);
