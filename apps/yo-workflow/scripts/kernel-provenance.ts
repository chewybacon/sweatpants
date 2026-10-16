import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("..", import.meta.url));
const names = ["ir", "validate", "dsl", "kernel"];
export async function buildLocalKernel() {
  let local: { checkout: string };
  try {
    local = JSON.parse(await readFile(resolve(app, ".wrangler/tisyn-local.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  execFileSync("pnpm", ["exec", "tsc", "-b", "packages/kernel", "packages/dsl"], {
    cwd: local.checkout,
    stdio: "inherit",
  });
}

export async function kernelProvenance(kernelSource: string) {
  let local: { checkout: string } | undefined;
  try {
    local = JSON.parse(await readFile(resolve(app, ".wrangler/tisyn-local.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const packages: Record<string, string> = {};
  for (const name of names) {
    const path = await realpath(resolve(app, "node_modules/@tisyn", name));
    if (local && path !== (await realpath(resolve(local.checkout, "packages", name)))) {
      throw new Error(
        `Tisyn ${name} is not linked to the selected checkout; run tisyn:local or tisyn:published.`,
      );
    }
    packages[`@tisyn/${name}`] = JSON.parse(
      await readFile(resolve(path, "package.json"), "utf8"),
    ).version;
  }
  let source: { revision: string; dirty: boolean; fingerprint: string } | null = null;
  if (local) {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: local!.checkout, encoding: "utf8" });
    const paths = names.flatMap((name) => [
      `packages/${name}/src`,
      `packages/${name}/package.json`,
      `packages/${name}/tsconfig.json`,
    ]);
    paths.push("tsconfig.json", "pnpm-lock.yaml");
    const files = [
      ...new Set(
        git("ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths)
          .split("\0")
          .filter(Boolean),
      ),
    ].sort();
    const hash = createHash("sha256");
    for (const file of files) {
      hash.update(file + "\0");
      try {
        hash.update(await readFile(resolve(local.checkout, file)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        hash.update("<deleted>");
      }
      hash.update("\0");
    }
    source = {
      revision: git("rev-parse", "HEAD").trim(),
      dirty: Boolean(git("status", "--porcelain", "--", ...paths).trim()),
      fingerprint: hash.digest("hex"),
    };
  }
  return {
    mode: local ? "local" : "published",
    packages,
    source,
    kernelSha256: createHash("sha256").update(kernelSource).digest("hex"),
  };
}
