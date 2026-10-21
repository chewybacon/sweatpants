import type { WorkflowCompiler, WorkflowLinker } from "@sweatpants/flowmode-runtime";
import {
  assertWorkflowLink,
  createWorkflowCompiler,
  createWorkflowLinker,
} from "@sweatpants/flowmode-runtime";
import { luaIdentity } from "./kernel.mts";
import type { LuaInvoker } from "./state.ts";

export function createLuaAuthoring(invoke: LuaInvoker) {
  const definitionFormat = "piccolo-lua-module-1";
  const luaCompiler: WorkflowCompiler = createWorkflowCompiler({
    driver: {
      sourceLanguage: "lua",
      definitionFormat,
      *compile({ source, entry, exports, bindings }) {
        if (source.language !== "lua") {
          return {
            ok: false,
            diagnostics: [
              { severity: "error", code: "source_language", message: "Expected Lua source" },
            ],
          };
        }
        try {
          yield* invoke({ action: "validate", source: source.text });
        } catch (error) {
          return {
            ok: false,
            diagnostics: [{ severity: "error", code: "lua_compile", message: String(error) }],
          };
        }
        return {
          ok: true,
          diagnostics: [],
          module: {
            entry,
            exports,
            imports: bindings,
            source,
            implementation: { format: definitionFormat, payload: source.text },
            debug: { sites: {}, locations: {} },
          },
        };
      },
    },
  });
  const luaLinker: WorkflowLinker = createWorkflowLinker({
    driver: {
      definitionFormat,
      programFormat: luaIdentity.programFormat,
      *link({ caller, bindings }) {
        assertWorkflowLink(caller, bindings);
        if (
          caller.implementation.format !== definitionFormat ||
          typeof caller.implementation.payload !== "string"
        ) {
          throw Error("Incompatible Lua caller");
        }
        const names = new Set(["input", "workflow", "pcall", "error", "assert", "type"]);
        const definitions: string[] = [];
        for (const binding of bindings) {
          const name = binding.contract.name;
          if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(name) || names.has(name)) {
            throw Error("Invalid or duplicate Lua binding");
          }
          names.add(name);
          if (binding.kind === "compiled") {
            const module = binding.module;
            if (
              module.implementation.format !== definitionFormat ||
              typeof module.implementation.payload !== "string" ||
              module.exports.length !== 1 ||
              module.exports[0]?.name !== binding.export
            ) {
              throw Error("Incompatible Lua compiled binding");
            }
            definitions.push(
              `local ${name} = (function()\n${module.implementation.payload}\nend)()`,
            );
          } else {
            // Elicit imports are called by compiled helpers through the intrinsic.
            if (binding.kind === "host" && binding.capability.name === "elicit") {
              continue;
            }
            // Select a long-string delimiter that cannot collide with the ID,
            // including IDs ending in ] (the shared JSON-array binding IDs).
            let equals = "=";
            while (binding.contract.id.includes(`]${equals}]`)) {
              equals += "=";
            }
            const id = `[${equals}[\n${binding.contract.id}]${equals}]`;
            definitions.push(
              `local function ${name}(value) return workflow.effect("${name}", {binding = ${id}, input = value}) end`,
            );
          }
        }
        const payload = `${definitions.join("\n")}\nreturn (function(input)\n${caller.implementation.payload}\nend)(input)`;
        yield* invoke({ action: "validate", source: payload });
        return { format: luaIdentity.programFormat, payload };
      },
    },
  });
  return { luaCompiler, luaLinker };
}
