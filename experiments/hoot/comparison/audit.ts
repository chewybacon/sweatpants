import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { execute } from "./harness.ts";
import { cases, type Language } from "./reference.ts";
const directory = resolve(process.argv[2]);
const summary = JSON.parse(readFileSync(join(directory, "summary.json"), "utf8")) as {
  rows: {
    task: string;
    language: Language;
    trial: number;
    attempts: { passed: boolean; source: string }[];
  }[];
};
const results = [];
for (const row of summary.rows.filter((r) => r.task === "badge" && r.attempts.at(-1)!.passed)) {
  const source = row.attempts.at(-1)!.source;
  const checks = [];
  const original = cases.find((t) => t.id === "badge")!.replies;
  for (const action of ["decline", "cancel"] as const)
    for (const at of [1, 2, 3, 5, 6]) {
      const result = await execute(row.language, source, original, action, at);
      assert.deepEqual(result.value, { status: action });
      checks.push(`${action} at question ${at + 1}`);
    }
  const result = await execute(row.language, source, [
    "Ada",
    "blue",
    "not sure",
    "change name",
    "Grace",
    "change color",
    "green",
    "done",
  ]);
  assert.deepEqual(result.value, { status: "done", name: "Grace", color: "green" });
  assert.equal(result.questions.length, 8);
  checks.push("unrecognized review reply re-prompts without losing state");
  results.push({ language: row.language, trial: row.trial, checks });
  writeFileSync(join(directory, "audit.json"), JSON.stringify(results, null, 2));
  console.log(row.language, row.trial, checks.length, "audit checks passed");
}
