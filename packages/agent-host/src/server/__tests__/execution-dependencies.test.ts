// @vitest-environment node
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

describe("execution dependency boundary", () => {
  it.each(["@sweatpants/agent-host", "@sweatpants/tool-session"])(
    "%s has no production dependency path to a concrete executor",
    (entry) => {
      const directory = fileURLToPath(new URL("../../../../", import.meta.url));
      const manifests = new Map<string, Manifest>();
      for (const name of readdirSync(directory, { withFileTypes: true })) {
        if (!name.isDirectory() || !existsSync(resolve(directory, name.name, "package.json"))) {
          continue;
        }
        const manifest = JSON.parse(
          readFileSync(resolve(directory, name.name, "package.json"), "utf8"),
        ) as Manifest;
        manifests.set(manifest.name, manifest);
      }
      expect(manifests.has(entry)).toBe(true);
      const seen = new Set<string>();
      const pending = [[entry]];
      while (pending.length) {
        const path = pending.pop()!;
        const name = path[path.length - 1];
        if (seen.has(name)) {
          continue;
        }
        seen.add(name);
        expect(path, "Concrete execution belongs in adapter packages").not.toContain(
          "@sweatpants/tool-runtime-local",
        );
        expect(path, "Concrete execution belongs in adapter packages").not.toContain(
          "@sweatpants/tool-runtime-agentcore",
        );
        const manifest = manifests.get(name);
        for (const dependency of Object.keys({
          ...manifest?.dependencies,
          ...manifest?.optionalDependencies,
          ...manifest?.peerDependencies,
        })) {
          pending.push([...path, dependency]);
        }
      }
      expect(seen).toContain(entry);
    },
  );
});
