# Framework Documentation

Documentation for core contributors to the Sweatpants framework.

## Documents

| Document | Description |
|----------|-------------|
| **[INTERNALS.md](./INTERNALS.md)** | Complete architecture guide - start here |
| **[GLOSSARY.md](./GLOSSARY.md)** | Framework-specific terminology |
| **[TRACE.md](./TRACE.md)** | Line-by-line execution trace of `book_flight` |

## Quick Links

### Understanding the Architecture
- [End-to-End Flow](./INTERNALS.md#end-to-end-flow-book-a-flight) - Sequence diagram of multi-turn tool
- [The Execution Model](./INTERNALS.md#chapter-1-the-execution-model) - How generators enable suspension
- [Session Management](./INTERNALS.md#chapter-2-session-management) - Tracking suspended tools
- [The Chat Engine](./INTERNALS.md#chapter-5-the-chat-engine) - State machine overview

### Key Concepts
- [Elicit](./GLOSSARY.md#elicit--elicitation) - Request user input (suspends tool)
- [Sample](./GLOSSARY.md#sample) - Request LLM completion (doesn't suspend)
- [BridgeHost](./GLOSSARY.md#bridgehost) - Tool execution container
- [Plugin](./GLOSSARY.md#plugin) - Client-side UI handlers

### Code Locations
| Component | Location |
|-----------|----------|
| Chat Engine | [`src/handler/durable/chat-engine.ts`](../src/handler/durable/chat-engine.ts) |
| BridgeHost | [`src/lib/chat/mcp-tools/bridge-runtime.ts`](../src/lib/chat/mcp-tools/bridge-runtime.ts) |
| Session Manager | [`src/handler/durable/plugin-session-manager.ts`](../src/handler/durable/plugin-session-manager.ts) |
| Tool Session | [`src/lib/chat/mcp-tools/session/tool-session.ts`](../src/lib/chat/mcp-tools/session/tool-session.ts) |
| React Hooks | [`src/react/chat/`](../src/react/chat/) |

## Archived Docs

Older design documents are in [`archive/`](./archive/). They may contain outdated information.
