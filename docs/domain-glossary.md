# Domain glossary

Use [execution vocabulary](execution-vocabulary.md) for computation and lifecycle
terms. This glossary names the application concepts surrounding them.

## Authoring

**Tool definition** is the compiled product of fluent `createTool` or
`createDurableTool` authoring. It carries parameters, optional output schema,
interaction declarations, metadata and inferred result evidence. Authors pass the
same definition to `makePlugin(tool)` and to placement. They do not separately wire
a declaration or expose an executable body symbol.

**Durable authoring** declares the effects and interactions needed for replayable
execution. It does not by itself persist a call. The selected host and journal
provide durability. Native-context tool authoring and retained execution adapters
still exist; a common definition shape does not make every placement compatible.

**Effect declaration** identifies an operation's input/output schemas, version and
retry policy. Its implementation is installed by the host. Keyed declarations keep
argument and reply types correlated; separate unions of all inputs and outputs
would lose that relation.

**Elicitation** is a request for an external answer. Its declaration owns context
and response schemas. Accept, decline and cancel are distinct answers. Cancelling
an elicitation is not automatically the same command as stopping a chat turn.

**Sampling** asks a model for a response. A tool can request a nested sample; the
host owns the provider stream and accepts its final result. Streamed text is
provisional publication, not an accepted outcome for each chunk.

**Plugin** connects an authored tool's interaction bindings to client behavior and
rendering. Its browser contract is derived from the definition. A plugin does not
own execution or the journal.

## Admission and placement

**Registry** is a heterogeneous collection used for name-based tool selection.
Model-selected calls cross a dynamic boundary: the name and JSON arguments require
lookup and validation. This boundary intentionally erases concrete result types.

**ToolContract** is a metadata projection useful to consumers that need schemas,
capabilities or bindings. **AnyTool**-style types erase a heterogeneous collection.
Neither role requires another author-managed execution definition.

**Placement** chooses where and how to acquire compute. Current iterator paths use
`inProcess()`, `local({ worker })` and `routeTools(...)`. Concrete preparation
preserves the selected definition's input and result types; registry preparation
binds name-based acquisition. Preparation validates routes without starting work.

**Interface digest** identifies the projected tool interface used by clients and
workers. It does not prove the identity of arbitrary implementation bytes.
**Program digest** pins the program identity used by recovery. They are different
checks, with different owners.

## Chat and recovery

A **conversation** owns accepted message history and user commands. A **logical
turn** represents work admitted for that conversation. An **execution ID** identifies
its execution; a **model call ID** correlates a tool request and result. Command IDs,
suspension IDs and worker generations solve other correlation problems and must not
be substituted for one another.

A **journal** records the requests, attempts and accepted outcomes used by recovery.
A **projection** derives client-visible messages and pending interactions from
accepted state, plus explicitly provisional stream output. A **snapshot** in the
client API is a view of conversation state; a Flowmode **kernel snapshot** captures
portable evaluator state. Neither is an alias for the other.

Sources: [definition](../packages/agent-sdk/src/tool/definition.ts),
[tool compilation](../packages/agent-sdk/src/tool/journal-compiler.ts),
[placement](../packages/tool-session/src/execution/tool-placement.ts),
[chat store](../packages/agent-host/src/primitive/store.ts),
[projection](../packages/agent-host/src/primitive/presentation.ts).
