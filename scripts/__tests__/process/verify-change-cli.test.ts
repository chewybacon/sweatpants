import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = fileURLToPath(new URL("../../verify-change.ts", import.meta.url));

it("plans a focused test with fresh build prerequisites and owning strict checks, without running them", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      cli,
      "--plan",
      "--test",
      "packages/flowmode-runtime/src/__tests__/composition.test.ts",
    ],
    { cwd: root, encoding: "utf8" },
  );
  expect(output).toContain("Build selected projects and prerequisites");
  expect(output).toContain("@sweatpants/flowmode-runtime...");
  expect(output).toContain("check:tests packages/flowmode-runtime");
  expect(output).toContain("vitest run src/__tests__/composition.test.ts");
  expect(output).toContain("Plan only; no checks executed");
  expect(output).not.toContain("Tests: @sweatpants/platform-acceptance");
});

it("routes Lua's mts tests through Node rather than silently collecting no Vitest tests", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      cli,
      "--plan",
      "--test",
      "packages/flowmode-runtime-lua/src/__tests__/fuel.mts",
    ],
    { cwd: root, encoding: "utf8" },
  );
  expect(output).toContain("node --import tsx --test src/__tests__/fuel.mts");
});

it("prepares the generated workflow fixture before a Scheme test that imports the app service", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      cli,
      "--plan",
      "--test",
      "packages/flowmode-runtime-scheme/src/execution/__tests__/authoring-validation.mjs",
    ],
    { cwd: root, encoding: "utf8" },
  );
  expect(output).toContain("yo-workflow^...");
  expect(output).toContain("Build workflow fixtures: pnpm --filter yo-workflow execution:compile");
  expect(output.indexOf("Build workflow fixtures")).toBeLessThan(
    output.indexOf("Test: packages/flowmode-runtime-scheme"),
  );
  expect(output).toContain("Additional types: @sweatpants/flowmode-runtime-scheme");
});

it("fails on misspelled package selectors before executing a check", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cli, "--package", "not-a-project"],
    { cwd: root, encoding: "utf8" },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Unknown workspace project");
});
