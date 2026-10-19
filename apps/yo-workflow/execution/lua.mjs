import {
  createWorkflowGuidance,
  requireCompiledWorkflow,
} from "../../../packages/workflow-kernel/dist/index.js";
import {
  reviewExports,
  reviewImports,
} from "../../../experiments/workflow-kernel/tsdown-authoring/contracts.mts";
import { createLuaAuthoring } from "../../../experiments/workflow-kernel/teal-lua-checkpoint/authoring.mts";
import { createLuaProgram } from "../../../experiments/workflow-kernel/teal-lua-checkpoint/program.mjs";
const source = `local function review_draft(input)
  local result = workflow.scope(function()
    local answer = workflow.effect("review_draft/answer", {"elicit", "approval", input.title})
    if answer.action == "accept" and answer.content.approved then return "Draft approved" end
    return "Draft declined"
  end, function()
    workflow.effect("review_draft/cleanup", {"elicit", "cleanup", "Release the draft reservation?"})
  end)
  return result
end
return review_draft`;
export function createLuaStack(invoke) {
  const { luaCompiler, luaLinker } = createLuaAuthoring(invoke);
  return {
    authoring: createWorkflowGuidance(
      "lua",
      `Write a Lua caller for Piccolo. Return only Lua source without Markdown. The local input is a JSON object with title, recipient and metadata. Call review_draft(input), a compiled developer function that asks for approval, then asks to release a reservation during cleanup. It returns "Draft approved" or "Draft declined". After approval only, call send_announcement(input) and return its receipt. On decline return an explanation string. Do not redefine these functions or call workflow.effect directly. Use local variables, functions, if, tables, arithmetic and ordinary calls. No imports, IO, eval, coroutine or standard library beyond assert, type, pcall, error. JSON null is workflow.null. Empty arrays use workflow.array({}). Return one JSON-compatible result. The outbox is local; no email is sent.`,
    ),
    descriptor: { id: "lua", label: "Lua", runtime: "Piccolo / Wasm", developerLanguage: "Lua" },
    linker: luaLinker,
    compiler: luaCompiler,
    createProgram: (options) => createLuaProgram(options, invoke),
    caller:
      "local function main(input)\n  local result = review_draft(input)\n  return result\nend\nlocal result = main(input)\nreturn result",
    /** @returns {import("effection").Operation<import("@sweatpants/workflow-kernel").CompiledWorkflow>} */
    *definition() {
      return requireCompiledWorkflow(
        yield* luaCompiler.compile({
          source: { id: "review-draft.lua", language: "lua", text: source },
          entry: "review_draft",
          exports: reviewExports,
          bindings: reviewImports,
        }),
      );
    },
  };
}
