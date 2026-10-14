import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { verify } from "./harness.ts";
import { cases, type Language } from "./reference.ts";
const directory = resolve(process.argv[2]);
const repairs = JSON.parse(readFileSync(join(directory, "diagnostic-repairs.json"), "utf8")) as {
  task: string;
  language: Language;
  trial: number;
  source: string;
  passed: boolean;
}[];
const task = cases.find((t) => t.id === "prs")!;
const results = [];
for (const row of repairs.filter((r) => r.task === "prs" && r.passed)) {
  const matchups = new Set<string>();
  const games = [];
  for (let i = 0; i < 30 && matchups.size < 9; i++) {
    const game = await verify(row.language, row.source, task);
    game.random.forEach((move, index) => matchups.add(`${task.replies[index + 1]} vs ${move}`));
    games.push(game);
  }
  assert.equal(matchups.size, 9, "Did not observe every matchup within audit bound");
  results.push({ language: row.language, trial: row.trial, matchups: [...matchups].sort(), games });
  writeFileSync(join(directory, "prs-audit.json"), JSON.stringify(results, null, 2));
  console.log(row.language, row.trial, games.length, "complete games, all nine matchups passed");
}
