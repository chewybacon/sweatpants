import asyncio
from sandbox import read_file

async def main():
    paths = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]
    return await asyncio.gather(*(read_file(path) for path in paths))
