# Current chat application configuration

The active yo-chat entry uses `createPrimitiveChatApp` from
`@sweatpants/agent-host/primitive`, wrapped by `createLocalYoChatApplication`.
This is the current SQLite journal host. The retained `createChatApp` API in
`@sweatpants/agent-host/server` is a separate compatibility surface; its options
must not be copied into the primitive host.

## Host options

`PrimitiveChatOptions` combines the following fields:

| Field              | Owner and purpose                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `database`         | Path to the SQLite journal/chat database.                                                                                    |
| `basePath`         | Optional HTTP route prefix. yo-chat uses `/api/chat`.                                                                        |
| `program`          | Pinned `{ id, version, digest }` identity for recovery.                                                                      |
| `model`            | Model object, provider driver and pinned configuration identity; optional stream options and selection/resolution functions. |
| `tools`            | The authored `ToolDefinition` inventory.                                                                                     |
| `effects`          | Host handlers keyed by `toolName.effectKey`, returning Outcome data.                                                         |
| `effectMiddleware` | Optional middleware inside declaration validation; receives canonical input and returns raw output.                          |
| `execution`        | Optional registry placement adapter. Omission selects in-process iterator tools.                                             |
| `authorize`        | Required policy for each conversation read/command.                                                                          |

The host rejects unknown options, duplicate tool names, missing effect handlers and
incomplete placement coverage. A nonempty program digest, model identity and
trusted authorization function are required. Model identity excludes credentials;
recovery needs a matching identity or a resolver for the recorded identity.

Use `createToolEffects(composition).handlers(tools)` to obtain declaration-correlated
handler types. Authors keep one fluent definition per tool and use
`makePlugin(tool)` for its client plugin. No separate compatibility definition is
required by this host.

## Placement

```ts
import { inProcess } from "@sweatpants/agent-host/server";
import { local } from "@sweatpants/tool-runtime-local";
import { routeTools } from "@sweatpants/tool-session/execution";

// Given authored tools and a worker entry registering those same definitions:
const execution = routeTools({
  default: inProcess(),
  routes: [{ tools: workerTools, runtime: local({ worker: workerUrl }) }],
});
```

`workerTools` and `workerUrl` above are application inputs. The host continues to
own model requests, native effect handlers and the journal. Workers acquire and
advance tool Guests. A parked activation closes its worker; recovery acquires fresh
compute and replays accepted outcomes.

The actual worker entry uses `serveWorkerGuest` and `createToolGuest`, validating
the registered name, version and interface digest. Registry selection is a dynamic
JSON boundary. Direct callers can instead use a concrete placement's
`prepare(tool, routeId).guest(input, callId)` and retain inferred Result types.

## yo-chat wiring

`src/server/tool-definitions.ts` is the shared six-tool inventory.
`src/server/tool-effects.ts` implements native effects. The app entry selects local
worker placement and resolves models through the Pi provider catalog.

The storage resolver must return SQLite with a path. The app adds `.primitive-v2`
to that path and stores thread metadata in a `.metadata` sidecar. It does not
reinterpret old ProgramDriver databases. Memory/Postgres authority settings are
not supported by this app entry. The ProgramDriver inspector is unavailable.

Model selection uses `DEFAULT_CHAT_MODEL_PROVIDER`, `DEFAULT_CHAT_MODEL_ID`,
`ALLOWED_CHAT_MODELS_JSON` and the developer override `UNSAFE_ALLOW_ANY_CHAT_MODEL`.
`MCP_TOOL_RUNTIME` accepts only `local`. The demo wrapper currently uses
`authorize: () => true`; that is demo policy, not an authentication implementation.
Application shutdown must await `close()` before releasing owned storage.

## Scope during the rewrite

Cloudflare, Lambda and AgentCore remain desired deployment targets. Their removed
app integrations are not current configuration choices. Framework runtime packages
remain, but their existence does not imply that the primitive HTTP host runs there.
There is no requirement to keep every former deployment operational during the
framework rewrite.

The lower-level `activateChat` API is runtime-portable and composes inside a caller's
scope. `startChatActivation` starts it through a Runtime. Callers supply matching
native model/effect implementations and own the journal lifetime. This portability
does not make the full HTTP host runtime-generic.

Sources: [options](../packages/agent-host/src/primitive/effection.ts),
[host](../packages/agent-host/src/primitive/app.ts),
[yo-chat entry](../apps/yo-chat/src/server/chat-application.ts),
[local wrapper](../apps/yo-chat/src/server/local-chat-application.ts),
[worker](../apps/yo-chat/src/server/journal-tool-worker.ts).
Evidence: [public app journeys](../acceptance/__tests__/application-composition/yo-chat-local.acceptance.test.ts),
[crash recovery](../acceptance/__tests__/host-crash/yo-chat-local.acceptance.test.tsx).
