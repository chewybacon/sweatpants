import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("..", import.meta.url));
const statePath = resolve(app, ".wrangler/tisyn-local.json");
const packages = ["ir", "validate", "dsl", "kernel"];
type State = { checkout: string; links: { name: string; previous: string; target: string }[] };
async function state(): Promise<State | undefined> {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function command(cwd: string, args: string[]) {
  execFileSync("pnpm", args, { cwd, stdio: "inherit" });
}
async function refresh(current: State) {
  for (const link of current.links) {
    if ((await realpath(resolve(app, "node_modules/@tisyn", link.name))) !== link.target) {
      throw new Error(`Local ${link.name} link changed. Restore it before refreshing.`);
    }
  }
  command(app, ["kernel:build"]);
}
const [mode, directory] = process.argv.slice(2);
const current = await state();
if (mode === "local") {
  if (!directory) throw new Error("Usage: pnpm tisyn:local /path/to/tisyn");
  const checkout = await realpath(resolve(directory));
  if (current) {
    if (current.checkout !== checkout)
      throw new Error("Run tisyn:published before changing checkouts.");
    await refresh(current);
  } else {
    command(checkout, ["exec", "tsc", "-b", "packages/kernel", "packages/dsl"]);
    const links: State["links"] = [];
    for (const name of packages) {
      const path = resolve(app, "node_modules/@tisyn", name);
      if (!(await lstat(path)).isSymbolicLink()) throw new Error(`Expected pnpm symlink: ${path}`);
      const target = await realpath(resolve(checkout, "packages", name));
      const manifest = JSON.parse(await readFile(resolve(target, "package.json"), "utf8"));
      if (manifest.name !== `@tisyn/${name}`) throw new Error(`Unexpected package at ${target}`);
      links.push({ name, previous: await readlink(path), target });
    }
    const next = { checkout, links };
    await mkdir(dirname(statePath), { recursive: true });
    // Save the restoration record before replacing any links, including a partial failure.
    await writeFile(statePath, JSON.stringify(next, null, 2) + "\n", { flag: "wx" });
    for (const link of links) {
      const path = resolve(app, "node_modules/@tisyn", link.name);
      await rm(path);
      await symlink(link.target, path, "dir");
    }
    await refresh(next);
  }
} else if (mode === "refresh") {
  if (!current) throw new Error("No local Tisyn checkout selected. Run tisyn:local first.");
  await refresh(current);
} else if (mode === "published") {
  if (current) {
    for (const link of current.links) {
      const path = resolve(app, "node_modules/@tisyn", link.name);
      let actual: string | undefined;
      try {
        actual = await readlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (actual !== undefined && actual !== link.target && actual !== link.previous) {
        throw new Error(`Refusing to replace independently changed link: ${path}`);
      }
    }
    for (const link of current.links) {
      const path = resolve(app, "node_modules/@tisyn", link.name);
      await rm(path, { force: true });
      await symlink(link.previous, path, "dir");
    }
    await rm(statePath);
  }
  command(app, ["kernel:build"]);
} else if (mode !== "status") {
  throw new Error("Expected local, refresh, published, or status");
}
const selected = await state();
console.log(
  JSON.stringify(
    {
      mode: selected ? "local" : "published",
      checkout: selected?.checkout,
      packages: Object.fromEntries(
        await Promise.all(
          packages.map(async (name) => [
            name,
            await realpath(resolve(app, "node_modules/@tisyn", name)),
          ]),
        ),
      ),
      bundle: JSON.parse(
        await readFile(
          resolve(app, "src/workflow/evaluation/generated/kernel-source.json"),
          "utf8",
        ),
      ).provenance,
    },
    null,
    2,
  ),
);
