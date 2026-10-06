import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dependencyBuildArgs, launchApp } from "../../dev-app.ts";

describe("development launch process", () => {
  it("does not start an app after a failed build; rebuilds before every successful launch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "yo-launch-"));
    const previousPath = process.env["PATH"];
    const executable = join(directory, "pnpm");
    const log = join(directory, "calls");
    // A fake package manager tests process orchestration; it never runs a product app or model.
    const script = (exit: number) =>
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nif [ "$1" = "--filter" ]; then exit ${exit}; fi\n`;
    try {
      process.env["PATH"] = `${directory}:${previousPath}`;
      writeFileSync(executable, script(7));
      chmodSync(executable, 0o755);
      await expect(launchApp("yo-mcp", ["tsx", "src/cli.ts", "two words"])).rejects.toThrow("7");
      expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
      writeFileSync(log, "");
      writeFileSync(executable, script(0));
      await launchApp("yo-mcp", ["tsx", "src/cli.ts", "two words"]);
      await launchApp("yo-mcp", ["tsx", "src/cli.ts", "two words"]);
      const calls = readFileSync(log, "utf8").trim().split("\n");
      expect(calls).toEqual([
        dependencyBuildArgs("yo-mcp").join(" "),
        "exec tsx src/cli.ts two words",
        dependencyBuildArgs("yo-mcp").join(" "),
        "exec tsx src/cli.ts two words",
      ]);
    } finally {
      process.env["PATH"] = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
