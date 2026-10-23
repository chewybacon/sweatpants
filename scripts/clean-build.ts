import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const generatedDirectories = new Set(["dist", ".tsup"]);
const generatedFiles = new Set(["tsconfig.tsbuildinfo"]);

async function removeGenerated(path: string): Promise<number> {
  let removed = 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return removed;
  }

  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      if (generatedDirectories.has(entry.name)) {
        await rm(child, { recursive: true, force: true });
        removed += 1;
        continue;
      }
      removed += await removeGenerated(child);
      continue;
    }
    if (generatedFiles.has(entry.name) || entry.name.endsWith(".tsbuildinfo")) {
      await rm(child, { force: true });
      removed += 1;
    }
  }
  return removed;
}

async function main(): Promise<void> {
  const removed = await removeGenerated(root);
  console.log(`Removed ${removed} generated build artifact(s).`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
