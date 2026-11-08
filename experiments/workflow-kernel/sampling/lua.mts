import type { CapabilityRequest } from "../../../packages/v2/core/src/index.ts";
import { createHash } from "node:crypto";
import { defineLuaEffectBindings } from "../../../packages/v2/codemode-runtime-lua/src/index.ts";
import { declarations, samplingProfile, prompt, validateSamplingRequest } from "./contracts.mts";
import type { SampleModel } from "./provider.mts";

// Authoring conveniences, not an authority boundary. Raw workflow.effect exchanges
// still pass through the same declared bindings and host grants.
const prelude = `
local exchange = workflow.effect
local function sample(request)
  return exchange("sample", { effect = "sample", input = request })
end
local function sampleSchema(request)
  return exchange("sampleSchema", { effect = "sampleSchema", input = request })
end
local function elicit(request)
  return exchange("elicit", { effect = "elicit", input = request })
end
`;

export function bindLuaSamplingProgram(
  caller: string,
  identity: string,
  model: SampleModel,
): {
  source: string;
  program: string;
  decodeRequest(boundary: unknown): CapabilityRequest;
} {
  const source = prelude + caller;
  const bindings = defineLuaEffectBindings(declarations);
  const program =
    "sampling-lua/1:" +
    createHash("sha256")
      .update(JSON.stringify({ source, identity, model, profile: samplingProfile }))
      .digest("hex");
  return {
    source,
    program,
    decodeRequest: (boundary: unknown) => validateSamplingRequest(bindings.decodeRequest(boundary)),
  };
}

const winner = `
local function winner(machine, player)
  if machine == player then return "tie" end
  if (machine == "rock" and player == "paper") or
     (machine == "paper" and player == "scissors") or
     (machine == "scissors" and player == "rock") then return "player" end
  return "model"
end
`;
export const luaGameCaller =
  winner +
  `
local rounds = ...
local result = ""
for remaining = rounds, 1, -1 do
  local sampled = sample({ prompt = ${JSON.stringify(prompt)} .. remaining })
  if not sampled.ok then return result .. "sample rejected" end
  local machine = sampled.value.text
  if machine ~= "rock" and machine ~= "paper" and machine ~= "scissors" then
    return result .. "invalid model move"
  end
  local answer = elicit({ message = "Choose rock, paper, or scissors. Round " .. remaining })
  if not answer.ok then return result .. "player declined" end
  result = result .. winner(machine, answer.value) .. ";"
end
return result
`;

export const structuredLuaCaller =
  winner +
  `
local sampled = sampleSchema({ prompt = "Choose a move and explain it briefly." })
if not sampled.ok then return "sample rejected" end
if not sampled.value.valid then return sampled.value.reason end
local plan = sampled.value.value
local answer = elicit({ message = plan.reason })
if not answer.ok then return "player declined" end
return winner(plan.move, answer.value)
`;
