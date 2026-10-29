# Supplied contracts: Scope, operation, join, gather, Queue.
# Operations are local confirmations; nothing is sent to an external service.
async def review(name):
    try:
        return await operation("Review " + name)
    finally:
        await operation("Release " + name)


async def workflow():
    try:
        async with Scope() as scope:
            first = scope.spawn(review("draft A"))
            second = scope.spawn(review("draft B"))
            a = await join(first)
            b = await join(second)
        return [a, b]
    finally:
        await operation("Finish parent cleanup")
