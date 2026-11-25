import anyio
from sandbox import read_file

async def read_one(path):
    try:
        return await read_file(path)
    finally:
        with anyio.CancelScope(shield=True):
            await read_file("cleanup-" + path)

async def main():
    try:
        async with anyio.create_task_group() as group:
            group.start_soon(read_one, "a.txt")
            group.start_soon(read_one, "b.txt")
            await read_file("c.txt")
    finally:
        with anyio.CancelScope(shield=True):
            await read_file("session-cleanup.txt")
    return "done"
