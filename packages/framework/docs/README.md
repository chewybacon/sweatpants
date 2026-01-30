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
- [Architecture Overview](./INTERNALS.md#architecture-overview) - Core vs Framework, two ways to build tools
- [End-to-End Flow](./INTERNALS.md#end-to-end-flow-book-a-flight) - Sequence diagram of multi-turn tool
- [The Execution Model](./INTERNALS.md#chapter-1-the-execution-model) - How generators enable suspension
- [Session Management](./INTERNALS.md#chapter-2-session-management) - Tracking suspended tools
- [The Chat Engine](./INTERNALS.md#chapter-5-the-chat-engine) - State machine overview
- [The Core Package](./INTERNALS.md#chapter-7-the-core-package) - Simpler tool API, transport model

### Key Concepts

#### @sweatpants/core
- [Core Tool / Tool Factory](./GLOSSARY.md#core-tool--tool-factory) - `createTool()` pattern
- [Agent](./GLOSSARY.md#agent) - Group tools with shared config
- [Principal / Operative](./GLOSSARY.md#principal) - Communication model
- [Transport](./GLOSSARY.md#transport) - Bidirectional message channel

#### @sweatpants/framework
- [Elicit](./GLOSSARY.md#elicit--elicitation) - Request user input (suspends tool)
- [Sample](./GLOSSARY.md#sample) - Request LLM completion (doesn't suspend)
- [BridgeHost](./GLOSSARY.md#bridgehost) - Tool execution container
- [Plugin](./GLOSSARY.md#plugin) - Client-side UI handlers

### Code Locations

#### Core Package (`packages/core/`)
| Component | Location |
|-----------|----------|
| createTool | [`packages/core/src/tool/create.ts`](../../core/src/tool/create.ts) |
| createAgent | [`packages/core/src/agent/create.ts`](../../core/src/agent/create.ts) |
| Built-ins (elicit, notify, sample) | [`packages/core/src/builtins/api.ts`](../../core/src/builtins/api.ts) |
| Transport Types | [`packages/core/src/types/transport.ts`](../../core/src/types/transport.ts) |

#### Framework Package (`packages/framework/`)
| Component | Location |
|-----------|----------|
| Chat Engine | [`src/handler/durable/chat-engine.ts`](../src/handler/durable/chat-engine.ts) |
| BridgeHost | [`src/lib/chat/mcp-tools/bridge-runtime.ts`](../src/lib/chat/mcp-tools/bridge-runtime.ts) |
| Session Manager | [`src/handler/durable/plugin-session-manager.ts`](../src/handler/durable/plugin-session-manager.ts) |
| Tool Session | [`src/lib/chat/mcp-tools/session/tool-session.ts`](../src/lib/chat/mcp-tools/session/tool-session.ts) |
| Core Tool Adapter | [`src/lib/chat/core-tools/adapter.ts`](../src/lib/chat/core-tools/adapter.ts) |
| Framework Transport | [`src/lib/chat/core-tools/framework-transport.ts`](../src/lib/chat/core-tools/framework-transport.ts) |
| React Hooks | [`src/react/chat/`](../src/react/chat/) |

## Archived Docs

Older design documents are in [`archive/`](./archive/). They may contain outdated information.
