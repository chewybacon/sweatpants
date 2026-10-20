local input = ...
local command = task_command
local protected = pcall
local raise = error
workflow = {}
local function wrap(body)
  return function()
    local ok, value = protected(function()
      command("start")
      return body()
    end)
    -- Completed values remain guest values, including closures and shared tables.
    -- This suspended frame roots them in the same checkpoint graph as live tasks.
    while true do command("done", ok, value) end
  end
end
function workflow.spawn(body)
  local id = command("spawn", wrap(body))
  -- A task handle is a guest closure, so boundary JSON rejects it.
  return function() return id end
end
function workflow.join(task) return command("join", {task()}) end
local function group(kind, bodies)
  local ids = {}
  for i = 1, #bodies do ids[i] = workflow.spawn(bodies[i])() end
  return command(kind, ids)
end
function workflow.all(bodies) return group("all", bodies) end
function workflow.race(bodies) return group("race", bodies) end
function workflow.effect(site, input) return command("effect", site, input) end
function workflow.scope(body, cleanup)
  -- The body task owns descendants. Joining it drains those descendants before
  -- this lexical scope runs cleanup, even when the body returns normally.
  local ok, value = protected(function()
    return workflow.join(workflow.spawn(body))
  end)
  command("cleanup-enter")
  local clean_ok, clean_error = protected(cleanup)
  command("cleanup-leave")
  if not clean_ok then raise(clean_error) end
  if not ok then raise(value) end
  return value
end
-- Contract: milliseconds; deadline uses Unix epoch milliseconds. The host must
-- accept deadlines once and arrange shutdown-safe activation wakeups. Expiry
-- must use ordered settlements, then cancel/drain scoped work before throwing.
-- Until that path exists, fail before spawning the body or emitting effects.
local function timer_unavailable()
  raise({
    code = "durable_timer_not_implemented",
    message = "Durable workflow timers are not implemented: journal-accepted deadlines, shutdown-safe activation wakeups, and ordered timer settlements are required. An in-process timer is not a durable wakeup."
  })
end
function workflow.sleep(duration_ms) return timer_unavailable() end
function workflow.timebox(duration_ms, body) return timer_unavailable() end
function workflow.deadline(at_ms, body) return timer_unavailable() end
local root = wrap(function()
