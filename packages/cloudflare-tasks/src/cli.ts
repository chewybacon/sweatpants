#!/usr/bin/env node
import { register } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { tsImport } from "tsx/esm/api";
import { withWranglerEnv, type WranglerTask } from "./index.js";

async function main(): Promise<void> {
  // Options belong before the task path; everything after it belongs to the task.
  const input = process.argv.slice(2);
  const valueFlags = new Set(["--config", "--env", "--persist-to"]);
  let split = 0;
  while (split < input.length && input[split].startsWith("-")) {
    split += valueFlags.has(input[split]) ? 2 : 1;
  }
  const { values } = parseArgs({
    args: input.slice(0, split),
    options: {
      config: { type: "string" },
      env: { type: "string" },
      "persist-to": { type: "string" },
      "remote-bindings": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "cf-task [--config path] [--env name] [--persist-to dir] [--remote-bindings] task.ts [task args]",
    );
    return;
  }
  const script = input[split];
  if (!script) {
    throw new Error("Expected a task module exporting a default function. Use --help for usage.");
  }
  await withWranglerEnv<Record<string, unknown>, void>(
    {
      config: values.config,
      environment: values.env,
      persistTo: values["persist-to"],
      remoteBindings: values["remote-bindings"],
    },
    async (env) => {
      Reflect.set(globalThis, Symbol.for("@sweatpants/cloudflare-tasks/env"), env);
      register(new URL("./hooks.js", import.meta.url));
      const module = (await tsImport(pathToFileURL(resolve(script)).href, import.meta.url)) as {
        default?: WranglerTask<Record<string, unknown>>;
      };
      if (typeof module.default !== "function") {
        throw new Error("Task module must export a default function.");
      }
      await module.default({ env, args: input.slice(split + 1) });
    },
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
