# Node SQLite adapter preparation

This package currently exports `v8Serializer`, the Node binary serializer selected
for the first SQLite implementation. The database/journal adapter is not implemented
yet. Node imports stay here; the portable storage package contains only the contract.

The `node-v8:1` identity names this adapter representation. Encoding and decoding
use Node's native `v8.serialize` / `v8.deserialize`, with no added JSON conversion or
domain schema validation. Hosted acceptance includes Map, bigint and Uint8Array
values. Functions and other unsupported native values throw during encoding.
This is not a promise to support all structuredClone values or interoperate with
Cloudflare or another language runtime. Node/runtime-version persistence compatibility
and real Lua checkpoint payloads still need evidence before claiming durable storage.

Assembly can select or wrap this serializer through existing contexts and scoped
APIs. Resolve before entering the database transaction; synchronous payload encoding
must finish before commit. If resolution suspends, authority must be checked against
current transactional state afterward. Encoding failure must roll back all affected
records, including owned-child settlement. The current hosted transport tracer
establishes the composition/fencing behavior, not those future SQLite guarantees.
