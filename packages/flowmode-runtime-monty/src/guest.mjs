// Generated from guest/*.py; regenerate with scripts/guest.mjs.
export const guestLibrary =
  "# Legacy host operation helpers, implemented using public asyncio APIs.\n# New authored programs import sandbox capabilities directly.\nimport asyncio\n\nasync def operation(label):\n    return await exchange(label)\n\nasync def join(handle):\n    return await handle\n\nasync def gather(*continuations):\n    return await asyncio.gather(*continuations)\n\nQueue = asyncio.Queue\n";
export const demoSource =
  'import asyncio\nfrom sandbox import read_file\n\nasync def main():\n    paths = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]\n    return await asyncio.gather(*(read_file(path) for path in paths))\n';
export const cleanupSource =
  'import asyncio\nfrom sandbox import read_file\n\nclass ReadSession:\n    async def __aenter__(self):\n        return self\n\n    async def __aexit__(self, kind, error, traceback):\n        await read_file("session-cleanup.txt")\n\nasync def read_one(path):\n    try:\n        return await read_file(path)\n    finally:\n        await read_file("cleanup-" + path)\n\nasync def main():\n    async with ReadSession():\n        return await asyncio.gather(read_one("a.txt"), read_one("b.txt"))\n';
export const errorSource =
  'import sandbox as files\nfrom sandbox import read_file as read\n\nasync def main():\n    try:\n        await files.read_file(path="missing.txt")\n    except FileNotFoundError as error:\n        return [str(error), await read("a.txt")]\n';
export const anyioSource =
  'import anyio\nfrom sandbox import read_file\n\nasync def read_one(path):\n    try:\n        return await read_file(path)\n    finally:\n        with anyio.CancelScope(shield=True):\n            await read_file("cleanup-" + path)\n\nasync def main():\n    try:\n        async with anyio.create_task_group() as group:\n            group.start_soon(read_one, "a.txt")\n            group.start_soon(read_one, "b.txt")\n            await read_file("c.txt")\n    finally:\n        with anyio.CancelScope(shield=True):\n            await read_file("session-cleanup.txt")\n    return "done"\n';
