import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "effection";
import { invokeWasm } from "../wasm-node.mts";

test("fuel checkpoints restore nested calls, open cells and pcall without repeating effects", async () => {
  const source = `local before = workflow.effect("before", {})
local total = before
local function add() total = total + 1 end
local ok, value = pcall(function()
  for i = 1, 5000 do add() end
  return total
end)
return {ok=ok, total=value}`;
  await run(function* () {
    let state = yield* invokeWasm({ action: "start", source });
    assert.equal((state.boundary as { kind: string }).kind, "suspended");
    state = yield* invokeWasm({ action: "resume", source, state, reply: 7, fuel: 1000 });
    let pauses = 0;
    let fuel = Number(state.fuel_used);
    while ((state.boundary as { kind: string }).kind === "compute_paused") {
      assert.ok(++pauses < 500);
      // Every call instantiates new WASM; JSON serialization discards all host state.
      state = yield* invokeWasm({
        action: "restore",
        source,
        state: JSON.parse(JSON.stringify(state)),
      });
      state = yield* invokeWasm({ action: "continue", source, state, fuel: 1000 });
      assert.ok(Number(state.fuel_used) > fuel);
      fuel = Number(state.fuel_used);
    }
    assert.ok(pauses > 1);
    assert.deepEqual(state.boundary, { kind: "completed", value: { ok: true, total: 5007 } });
  });
});

test("cancelling compute unwinds through cleanup and never resumes the loop", async () => {
  const source = `return workflow.scope(function()
    while true do end
  end, function(completion)
    workflow.effect("cleanup", {kind=completion.kind})
  end)`;
  await run(function* () {
    let state = yield* invokeWasm({ action: "start", source, fuel: 1000 });
    assert.deepEqual(state.boundary, { kind: "compute_paused" });
    state = yield* invokeWasm({ action: "cancel", source, state, reason: "stop" });
    assert.deepEqual(state.boundary, {
      kind: "suspended",
      request: { site: "cleanup", request: { kind: "cancel" } },
    });
    state = yield* invokeWasm({ action: "resume", source, state, reply: null });
    assert.deepEqual(state.boundary, { kind: "cancelled", reason: "stop" });
  });
});

test("compute pauses reject capability replies and do not reset cumulative fuel", async () => {
  await run(function* () {
    const source = "while true do end";
    const state = yield* invokeWasm({ action: "start", source, fuel: 1000 });
    assert.deepEqual(state.boundary, { kind: "compute_paused" });
    yield* assertRejectsResume(source, state);
    const next = yield* invokeWasm({ action: "continue", source, state, fuel: 1000 });
    assert.ok(Number(next.fuel_used) > Number(state.fuel_used));
  });
});
function* assertRejectsResume(
  source: string,
  state: Record<string, import("@sweatpants/foundation").Json>,
) {
  let error: unknown;
  try {
    yield* invokeWasm({ action: "resume", source, state, reply: null });
  } catch (caught) {
    error = caught;
  }
  assert.match(String(error), /action does not match Lua boundary/);
}

// Regression for the production solver: both the candidate pool and partially
// filtered pool must fit a checkpoint while the scoring loop is still active.
test("9000-candidate repeated-digit solver finishes across computation slices", async () => {
  const source = `local cands = {}
for a = 1, 9 do
  for b = 0, 9 do
    for c = 0, 9 do
      for d = 0, 9 do
        cands[#cands + 1] = {a, b, c, d}
      end
    end
  end
end

local function gs(d)
  return "" .. d[1] .. d[2] .. d[3] .. d[4]
end

-- Standard scoring that handles repeated digits.
local function score(secret, g)
  local bulls = 0
  local ss = {}
  local sg = {}
  for dgt = 0, 9 do
    ss[dgt] = 0
    sg[dgt] = 0
  end
  for i = 1, 4 do
    if secret[i] == g[i] then
      bulls = bulls + 1
    else
      ss[secret[i]] = ss[secret[i]] + 1
      sg[g[i]] = sg[g[i]] + 1
    end
  end
  local cows = 0
  for dgt = 0, 9 do
    if ss[dgt] < sg[dgt] then
      cows = cows + ss[dgt]
    else
      cows = cows + sg[dgt]
    end
  end
  return bulls, cows
end


local kept = {}
for k = 1, #cands do
  local bulls, cows = score(cands[k], {1, 1, 2, 2})
  if bulls == 0 and cows == 0 then kept[#kept + 1] = cands[k] end
end
return {count=#kept, next=gs(kept[1])}`;
  await run(function* () {
    let state = yield* invokeWasm({ action: "start", source });
    let pauses = 0;
    while ((state.boundary as { kind: string }).kind === "compute_paused") {
      assert.ok(++pauses < 100);
      state = yield* invokeWasm({
        action: "continue",
        source,
        state: JSON.parse(JSON.stringify(state)),
      });
    }
    assert.ok(pauses > 1);
    assert.deepEqual(state.boundary, { kind: "completed", value: { count: 3584, next: "3000" } });
  });
});
