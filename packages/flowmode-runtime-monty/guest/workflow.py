from __monty_host__ import host_coroutines
import asyncio
import json


def _request(label):
    return (yield exchange(label))


async def operation(label):
    """Ask the host to complete a named local operation."""
    return await _request(label)


class Scope:
    def __init__(self):
        self.errors = []
        self.cleanups = []

    async def __aenter__(self):
        asyncio._scope()
        return self

    def spawn(self, continuation):
        return asyncio._spawn(_child(continuation))

    def cancel(self, handle):
        asyncio._cancel(handle)

    def defer(self, cleanup):
        self.cleanups.append(cleanup)

    async def __aexit__(self, kind, value, traceback):
        self.errors = await asyncio._drain()
        while self.cleanups:
            cleanup = self.cleanups.pop()
            try:
                await cleanup()
            except Exception as error:
                self.errors.append(error)


async def join(handle):
    return await handle


async def gather(*continuations):
    return await asyncio.gather(*continuations)


class Queue:
    def __init__(self, capacity):
        self.queue = asyncio._queue(capacity)

    async def put(self, value):
        await asyncio._queue_put(self.queue, value)

    async def get(self):
        return await asyncio._queue_get(self.queue)
