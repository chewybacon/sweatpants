-- One JSON result per workflow scope. Preserve the completion across yielding cleanup.
local input = ...
local protected = pcall
local raise = error
local enter_cleanup = workflow._enter_cleanup
local leave_cleanup = workflow._leave_cleanup
workflow._enter_cleanup = nil
workflow._leave_cleanup = nil
function workflow.scope(body, cleanup)
    local ok, value = protected(body)
    local completion = { kind = "return", value = value }
    if not ok then
        completion.kind = "throw"
        if value == "__workflow_cancelled__" then completion.kind = "cancel" end
    end
    enter_cleanup()
    local clean_ok, clean_error = protected(cleanup, completion)
    leave_cleanup()
    if not clean_ok then raise(clean_error) end
    if not ok then raise(value) end
    return value
end
function workflow.array(value)
    value.__workflow_json_array = true
    return value
end
function workflow.is_null(value)
    return type(value) == "table" and value.__workflow_json_null == true
end
