-- Application policy for the current VM, which has no general critical regions.
-- Stable keys let an authorized operator reconcile an uncertain acquisition/commit.
-- A confirmation must establish a final external outcome, not a transient lookup.
local input = ...
local resource = input.resource
local acquired = false
local acquiring = false
local committing = false
local committed = false

local function call(kind)
  return workflow.effect(kind, { kind = kind, resource = resource })
end

local function repair(operation, failure)
  return workflow.effect("repair", {
    kind = "repair", resource = resource, operation = operation, failure = failure
  })
end

-- The cleanup closure exists before any acquisition can be dispatched.
return workflow.scope(function()
  acquiring = true
  local reserved = call("reserve")
  assert(reserved == resource)
  acquiring = false
  acquired = true

  assert(call("approve") == "approved")
  committing = true
  assert(call("commit") == "committed")
  committing = false
  committed = true
  return "active"
end, function(completion)
  if committed then return end

  if committing then
    local decision = repair("commit", "Commit outcome unknown")
    if decision.action == "confirmed-committed" then
      committed = true
      return
    end
    assert(decision.action == "confirmed-not-committed")
  end

  if acquiring then
    local decision = repair("reserve", "Acquisition outcome unknown")
    assert(decision.action == "confirmed-present" or decision.action == "confirmed-absent")
    acquired = decision.action == "confirmed-present"
  end

  if acquired then
    local result = call("release")
    if result == "denied" then
      local decision = repair("release", "Release denied")
      assert(decision.action == "confirmed-released" or decision.action == "waive")
    else
      assert(result == "released")
    end
  end
end)
