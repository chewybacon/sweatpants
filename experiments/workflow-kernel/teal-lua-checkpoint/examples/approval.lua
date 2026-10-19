workflow.effect("prefix", { binding = "prefix", input = { message = "entered once" } })
local counter = 3
local shared = { count = 10 }
shared.self = shared
local alias = shared
local function bump() counter = counter + 1; return counter end
local function read() return counter end
local function review()
    local answer = workflow.effect("approval", { binding = "approval", input = input })
    if answer == false then error("declined") end
    local next = bump()
    shared.count = shared.count + 7
    return { counter = next, observed = read(), alias = alias == shared,
        cycle = shared.self == shared, count = shared.count }
end
return workflow.scope(review, function(completion)
    workflow.effect("cleanup", { binding = "cleanup", input = { completion = completion.kind } })
end)
