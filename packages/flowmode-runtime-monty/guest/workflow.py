# Legacy host operation helpers, implemented using public asyncio APIs.
# New authored programs import sandbox capabilities directly.
import asyncio

async def operation(label):
    return await exchange(label)

async def join(handle):
    return await handle

async def gather(*continuations):
    return await asyncio.gather(*continuations)

Queue = asyncio.Queue
