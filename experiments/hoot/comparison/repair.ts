import { readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { author } from "./author.ts";
import { cases, type Language } from "./reference.ts";
import { verify } from "./harness.ts";
const directory = resolve(process.argv[2]);
const summary = JSON.parse(readFileSync(join(directory, "summary.json"), "utf8")) as {
  rows: { task: string; language: Language; trial: number; attempts: { passed: boolean }[] }[];
};
const results = [];
for (const row of summary.rows.filter((r) => !r.attempts[0].passed)) {
  const filename = `${row.task}-${row.language}-${row.trial}-1.json`;
  const initial = JSON.parse(readFileSync(join(directory, filename), "utf8"));
  const { stdout, stderr } = await promisify(execFile)(
    fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url)),
    [fileURLToPath(new URL("./diagnose.ts", import.meta.url)), join(directory, filename)],
    {
      env: { ...process.env, NODE_OPTIONS: "--conditions=development" },
      timeout: 15000,
      maxBuffer: 65536,
    },
  );
  const diagnostic = stdout.trim() + "\n" + stderr.trim().slice(-3000);
  const prompt = `${initial.prompt}\n\nYour previous source:\n${initial.source}\n\nParser/evaluator diagnostic:\n${diagnostic}\n\nReturn a corrected complete program. This is your one repair attempt.`;
  console.log(`Diagnostic repair ${row.task}/${row.language}/${row.trial}: ${stdout.trim()}`);
  const generated = await author(prompt);
  let error: string | undefined;
  let validation: unknown;
  try {
    if (generated.generationError) throw new Error(generated.generationError);
    validation = await verify(
      row.language,
      generated.source,
      cases.find((t) => t.id === row.task)!,
    );
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const result = {
    task: row.task,
    language: row.language,
    trial: row.trial,
    prompt,
    diagnostic,
    ...generated,
    passed: !error,
    error,
    validation,
  };
  results.push(result);
  writeFileSync(
    join(directory, `${row.task}-${row.language}-${row.trial}-diagnostic-repair.json`),
    JSON.stringify(result, null, 2),
  );
  writeFileSync(join(directory, "diagnostic-repairs.json"), JSON.stringify(results, null, 2));
  console.log(error ? `FAIL ${error.slice(0, 200)}` : "PASS");
}
