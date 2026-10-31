import asyncio
import anyio

# operation() is the Execution demo's supplied host-step helper.
# Records here are simulated; each acknowledged step is journaled.
async def main():
    saved = []
    try:
        await operation("1. Reserve username")
        saved.append("username reservation")
        await operation("2. Create pending account")
        saved.append("pending account")
        await operation("3. Save profile")
        saved.append("profile")
        # Activation is the final host acknowledgement: success keeps the records.
        await operation("Activate account (keep all records)")
    except asyncio.CancelledError:
        # Only cancellation rolls back; validation failures are distinct.
        # Hard abandonment cannot run this handler.
        with anyio.CancelScope(shield=True):
            while saved:
                await operation("Undo: remove " + saved[-1])
                saved.pop()
        raise
    return {"status": "active", "retained_records": saved}
