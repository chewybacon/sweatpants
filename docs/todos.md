# scratch pad of ideas and things for the future that I want to build


## MCP stuff

### tool annotations in the spec

I want to investigate tool annontations and figure out if we can use that as a means to
allow elicit context from annotations for MCP clients in a configuration driven way

we should be able to declare an MCP tool with sweatpants in code and host it on our MCP server

but also have an MCP client package that can "self configure" the elicit context magic just from the
connection to the MCP server and reading the tool definitions possible code generating the client much
like openapi client generators work

/> `npx @sweatpants/cli generate-mcp-client -o some/path -i http://something.mcp/mcp.json`

## Architecture cleanup

### Split giant chat runtime state machines

- Break `packages/framework/src/handler/durable/chat-engine.ts` into phase-specific modules.
- Break `packages/framework/src/lib/chat/session/create-session.ts` into command-loop, continuation, elicit-response, and history-sync units.
- Extract shared event/patch mapping helpers so direct stream events and AG-UI checkpoint events use the same code path.
- Add targeted regression tests before each extraction to preserve behavior.

### Choose one canonical durable chat protocol path

- Decide whether `@sweatpants/durable-conversations` is the future public API, an internal experiment, or an archive candidate.
- Document the canonical flow for durable chat sessions, reconnects, tool calls, and elicitation.
- Remove or archive duplicate durable/session paths once the canonical path is selected.
- Update README and app examples to use only the canonical public API.

