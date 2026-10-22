import { createWorkflowGuidance } from "@sweatpants/flowmode-runtime";
import { createLuaAuthoring } from "@sweatpants/flowmode-runtime-lua/authoring";
import { createLuaProgram } from "@sweatpants/flowmode-runtime-lua/program";
/** @param {import("@sweatpants/flowmode-runtime-lua").LuaInvoker} invoke
 * @param {import("@sweatpants/flowmode-runtime").CompiledWorkflow} reviewDraft */
export function createLuaStack(invoke, reviewDraft) {
  const { luaCompiler, luaLinker } = createLuaAuthoring(invoke);
  return {
    authoring: /** @type {import("@sweatpants/flowmode-runtime").WorkflowAuthoring} */ (
      createWorkflowGuidance(
        "lua",
        `Write a Lua caller for Piccolo. Return only Lua source without Markdown. The local input is a JSON object with title, recipient and metadata. Call review_draft(input), a compiled developer function that asks for approval, then asks to release a reservation during cleanup. It returns "Draft approved" or "Draft declined". After approval only, call send_announcement(input) and return its receipt. On decline return an explanation string. Do not redefine these functions or call workflow.effect directly. Use local variables, functions, if, tables, arithmetic and ordinary calls. No imports, IO, eval, coroutine or standard library beyond assert, type, pcall, error. JSON null is workflow.null. Empty arrays use workflow.array({}). Return one JSON-compatible result. The outbox is local; no email is sent.`,
      )
    ),
    descriptor: {
      id: "lua",
      label: "Lua",
      runtime: "Piccolo / Wasm",
      developerLanguage: "TypeScript",
    },
    linker: luaLinker,
    compiler: luaCompiler,
    /** @param {Parameters<typeof createLuaProgram>[0]} options */
    createProgram: (options) => createLuaProgram(options, invoke),
    caller:
      "local function main(input)\n  local result = review_draft(input)\n  return result\nend\nlocal result = main(input)\nreturn result",
    /** @returns {import("effection").Operation<import("@sweatpants/flowmode-runtime").CompiledWorkflow>} */
    *definition() {
      return reviewDraft;
    },
  };
}
