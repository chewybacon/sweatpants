import asyncio
from sandbox import read_file

class ReadSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, kind, error, traceback):
        await read_file("session-cleanup.txt")

async def read_one(path):
    try:
        return await read_file(path)
    finally:
        await read_file("cleanup-" + path)

async def main():
    async with ReadSession():
        return await asyncio.gather(read_one("a.txt"), read_one("b.txt"))
