import { createHash } from "node:crypto";
import type {
  WorkflowModule,
  WorkflowLinker,
  LinkedWorkflow,
} from "@sweatpan.ts/codemode-compiler";
import { emitLuaWorkflowFunction, admitLuaCaller, luaString } from "./emit.ts";
const reserved = new Set([
  "input",
  "workflow",
  "error",
  "type",
  "and",
  "break",
  "do",
  "else",
  "elseif",
  "end",
  "false",
  "for",
  "function",
  "goto",
  "if",
  "in",
  "local",
  "nil",
  "not",
  "or",
  "repeat",
  "return",
  "then",
  "true",
  "until",
  "while",
]);
function linkLua(options: {
  module: WorkflowModule;
  caller: string;
  identity: string;
  name: string;
}) {
  const { module, identity } = options;
  const name = options.name;
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || reserved.has(name)) {
    throw new Error("Unsupported Lua link binding");
  }
  const implementation = emitLuaWorkflowFunction(module);
  const caller = admitLuaCaller(options.caller, name);
  const metadata = createHash("sha256").update(JSON.stringify(module.effects)).digest("hex");
  const source = `local __metadata = ${luaString(metadata)}\nlocal ${name} = (function()\n${implementation}\nend)()\nreturn (function(input)\n${caller}\nend)(...)`;
  const program =
    "linked-lua-review:" +
    createHash("sha256").update(JSON.stringify({ source, identity })).digest("hex");
  return {
    source,
    program,
    identity,
    language: "lua" as const,
    name,
    entry: module.entry.name,
    effects: structuredClone(module.effects),
  };
}
/** One compiled entry, using the shared linker contract and bounded Lua caller grammar. */
export const luaWorkflowLinker: WorkflowLinker<LinkedWorkflow> = {
  language: "lua",
  link({ module, caller, name, identity }) {
    if (caller.language !== "lua") {
      throw new Error("Unsupported Lua link binding");
    }
    return linkLua({ module, caller: caller.text, name, identity });
  },
};
