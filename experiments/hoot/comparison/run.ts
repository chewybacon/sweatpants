import { author } from "./author.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { common, references, cases, type Language } from "./reference.ts";
import { verify } from "./harness.ts";
const destination = new URL(
  `./results-${new Date().toISOString().replaceAll(":", "-")}/`,
  import.meta.url,
);
mkdirSync(destination, { recursive: true });
console.log(`Results: ${destination.pathname}`);
writeFileSync(
  new URL("references.json", destination),
  JSON.stringify({ common, references, cases }, null, 2),
);
const rows: unknown[] = [];
// Alternate which frontend goes first. Fresh authoring context for each trial.
for (let trial = 0; trial < 2; trial++)
  for (const [index, task] of cases.entries()) {
    for (const language of ((trial + index) % 2
      ? ["tisyn", "scheme"]
      : ["scheme", "tisyn"]) as Language[]) {
      const base = `${common}\n\nLANGUAGE REFERENCE\n${references[language]}\n\nUSER REQUEST\n${task.request}\n\nShared machine-readable completion contract for evaluation:\n${task.contract}`;
      const attempts = [];
      let prompt = base;
      for (let attempt = 0; attempt < 2; attempt++) {
        console.log(`Authoring ${task.id}/${language} trial ${trial + 1} attempt ${attempt + 1}`);
        const authored = await author(prompt);
        let validation: unknown;
        let error: string | undefined;
        try {
          if (authored.generationError) throw new Error(authored.generationError);
          validation = await verify(language, authored.source, task);
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        const result = {
          ...authored,
          sourceCharacters: authored.source.length,
          passed: !error,
          error,
          validation,
        };
        attempts.push(result);
        writeFileSync(
          new URL(`${task.id}-${language}-${trial + 1}-${attempt + 1}.json`, destination),
          JSON.stringify({ prompt, ...result }, null, 2),
        );
        console.log(`${task.id}/${language}: ${error ? `FAIL ${error.slice(0, 200)}` : "PASS"}`);
        if (!error) break;
        prompt = `${base}\n\nYour previous source:\n${authored.source}\n\nExecution/acceptance diagnostic:\n${error}\n\nReturn a corrected complete program. This is your one repair attempt.`;
      }
      rows.push({ task: task.id, language, trial: trial + 1, attempts });
      writeFileSync(
        new URL("summary.json", destination),
        JSON.stringify(
          { model: "opencode/claude-haiku-5-5", thinking: "medium", maxTokens: 12000, rows },
          null,
          2,
        ),
      );
    }
  }
console.log("Comparison complete");
