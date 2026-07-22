# React Chat Acceptance Boundary

`acceptance/hook-state.acceptance.test.ts` extends the deterministic test rig through the real React hook layer.

The canonical path is:

```text
rig-controlled OpenAI response
→ real framework handler and Program Runtime
→ AG-UI stream
→ createChatSession reducer
→ useChatSession React state
→ useElicitExecutor plugin execution
→ local/durable emission merge
→ useChat message derivation and rendering pipeline
```

Tests synchronize on React-visible semantics:

- `ui.message(...)`
- `ui.emission(...)`
- `ui.settled()`
- `ui.snapshot(...)`

`ui.settled()` requires the hook to observe an active run before accepting an idle state, so it cannot accidentally match the initial empty snapshot.

Raw AG-UI entries are captured by `ui.events()` for passive diagnostics and conformance assertions. They do not drive ordinary choreography.

The package owns two canonical scenarios on both in-process and HTTP bindings:

1. A model tool call reaches React, executes a real client plugin, emits a component and props, accepts the UI response, resumes the server tool, and renders the final Markdown response.
2. A hook unmounts while a plugin emission is pending; a new hook with the same durable conversation restores the emission exactly once, rejects the stale responder, resumes through the new responder, and completes.

The fixtures are package-owned. They do not import application or framework-acceptance fixtures.
