# Execution vocabulary and the episode analogy

This records the vocabulary agreed during the October 18, 2026 design discussion.
Activation names a host's episode of driving durable work. Execution names a
live computation used during that episode. Accepted work survives replacement of
both. This is a curated account of the discussion, not a verbatim transcript.

## Collaborators and responsibilities

| Collaborator | Responsibility |
| --- | --- |
| Task | Identifies durable work and its eventual outcome. |
| Journal authority | Accepts commands and results, authorizes advancement, and establishes accepted history. |
| Host | Coordinates advancement of a task during an activation. |
| Program driver | Connects the host's durable protocol to an attached computation, preserving command and receipt rules. |
| Backend | Connects evaluator requests to the host's effect runtime. |
| Kernel | Evaluates program semantics and supplies evaluator-specific capture and restore mechanics. |
| Executor | The capability to start a program and obtain a live execution and its initial boundary. A kernel implements this role. |
| Execution | The live capability to resume, cancel, and dispose a computation. Kernel executions also support capture. |
| Boundary | Reports a suspension, completion, program failure, or cancellation. |
| Transport | Carries commands and responses across a placement boundary. |

Principal and operative describe the two roles at a transport boundary: the
principal requests advancement; the operative owns the live computation. These
roles do not require extra layers in the local call stack.

## Identity and lifetime

A task can span many host activations. A host activation can drive multiple live
executions; the relationship is not necessarily one-to-one. Restoring computation
creates a fresh execution handle. It does not reactivate a disposed handle.

`ExecutionState` is the returned pair `{ execution, boundary }`.
`KernelExecutionState` specializes it with a snapshot-capable execution. These
are live values, not durable identities or serialized snapshots. The boundary in
the pair is the boundary at that return point; it does not update automatically
when the handle advances. The pair has no separate lifecycle; it is not another
collaborator called an activation.

The existing qualified term **Durable Execution** in journal and execution-tree
contracts refers to durable work. It must not be confused with the live
`Execution` interface. This vocabulary decision does not rename those authority
contracts or change their persistence semantics.

## Verbs

| Verb | Meaning |
| --- | --- |
| Activate | Begin a host episode of advancing durable work. |
| Start | Create fresh computation and evaluate to its first boundary. |
| Restore | Create fresh computation from captured evaluator state. |
| Replay | Reconstruct progress using accepted history, possibly after a checkpoint. |
| Recover | Bring fresh computation to the accepted position using restore, replay, or both. |
| Resume | Supply a reply to the current suspension and advance to the next boundary. |
| Suspend | Reach an evaluator boundary that requires something from the caller. |
| Park | Leave durable work waiting so its compute can be released. |
| Capture | Obtain evaluator state suitable for a snapshot. |
| Cancel | Initiate logical unwinding, which may suspend for cleanup requests. |
| Dispose | Release compute without promising logical cleanup or cancelling the durable task. |

Recovery uses resume operations internally to deliver recorded answers. The
distinction is their purpose: reconstructing accepted progress versus delivering
a newly accepted answer. Neither operation gives compute authority to rewrite
history.

## A request through the collaborators

```text
Host activation begins
  → Journal authority supplies authorized work and accepted recovery position
  → Program driver attaches
    → Backend opens computation
      → Scoped Executor.start
        → Recovery middleware selects Kernel.start or Kernel.restore
        → Accepted suffix is replayed when needed
      ← ExecutionState: live execution + current boundary
    → Backend presents the suspended request to the host effect runtime
  → Journal authority accepts the request
  → Recovery policy requests Execution.capture when supported
  → Driver and authority associate the snapshot with accepted protocol history
  → Host parks the task and disposes compute
Host activation ends

An authorized reply is accepted
  → A fresh host activation recovers the task
  → Execution.resume delivers the accepted reply
  ← Another suspension or terminal boundary
  → Journal authority accepts progress
  → Compute is disposed when the episode ends
```

Snapshot acceleration is optional. Journal authority and recovery validation
remain mandatory. Startup middleware surrounds both fresh and restored execution.

## How the analogy developed

The conversation explored a series, season, and episode to distinguish ongoing
identity from occurrences of work. A conversation or workflow instance is like
a series; a durable task is like a season; a host activation is like an episode.
The host coordinates production and executions provide replaceable compute.
These are explanatory comparisons, not proposed literal API names.

The user suggested that suspension is like an **ad break**: the story has not
ended, but continuation waits. Parking goes a step further by releasing the
production resources while the durable story waits.

**Audience** exposed two separate roles: observers watch the broadcast, while
authorized participants can answer a particular elicitation. Watching does not
grant permission to alter the story. **Broadcast** suggests live event delivery;
**syndication** suggests distributing recorded content to other consumers. Those
were useful exploratory terms, not new transport contracts or delivery guarantees.

The user compared replay with a recap episode, or a streaming service that makes
you watch the recap instead of offering **Skip recap**:

```text
Full replay:          beginning → recorded answers → accepted position
Checkpoint + replay: saved position → short recap → accepted position
Resume:              current suspension + answer → next scene
```

The checkpoint lets recovery skip reconstructing a prefix. Accepted history
determines what happened. Runtime replay reconstructs computation with recorded
outcomes; it is not merely rebroadcasting events or repeating settled effects.

## Why the host keeps activation

We compared both assignments: host activation with live execution, and host
turn or episode with program activation. Either could describe two distinct
lifetimes, but the final decision reserves activation for the host. We keep
execution for the live computation; no computation-side activate operation or
reactivation of a disposed handle is implied.

The resulting sentence is: the host begins an activation, starts or restores
executions, drives the task, and disposes its compute when the activation ends.

## Decisions to carry forward

- Reserve unqualified activation for the host's episode of work.
- Use execution for the live computation and execution state for its handle/boundary pair.
- Keep cancel and dispose distinct: conclude the work through unwinding versus release compute.
- Keep recovery policy composable through scoped middleware, with capture and restore mechanics owned by the evaluator.
- Do not infer a strict object hierarchy or a new API from the television analogy.

See [Shared execution boundary](./execution-boundary.md) for implementation details.
