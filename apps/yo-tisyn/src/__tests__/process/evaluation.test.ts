import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const loader = createRequire(import.meta.url).resolve("tsx");

describe("Tisyn compute guard", () => {
  it.each([
    ["pure while", "While(true,[1])", /exceeded 250 ms/],
    [
      "pure recursion",
      'Let("f",Fn([],Call(Ref("f"))),Call(Ref("f")))',
      /exceeded 250 ms|call stack/i,
    ],
  ])("stops %s without poisoning the next evaluation", async (_name, source, error) => {
    // An outer process watchdog prevents a broken in-process guard from hanging the test runner.
    const { stdout } = await exec(
      process.execPath,
      [
        "--import",
        loader,
        fileURLToPath(new URL("../fixtures/evaluation-runner.ts", import.meta.url)),
        String(source),
      ],
      { timeout: 5000 },
    );
    const report = JSON.parse(stdout);
    expect(report.failure).toMatch(error);
    expect(report.subsequent).toEqual({ done: true, value: 42 });
  });
});
