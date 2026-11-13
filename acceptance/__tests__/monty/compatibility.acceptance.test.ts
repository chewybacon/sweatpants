import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("valid executable repins reject old checkpoints before VM load and restore matching checkpoints", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--import",
    "tsx",
    resolve("monty-compatibility.mts"),
  ]);
  expect(JSON.parse(stdout).status).toBe("PASS");
}, 60_000);
