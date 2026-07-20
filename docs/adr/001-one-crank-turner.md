# ADR-001: One Crank Turner and Demand-Pulled Execution

**Status:** Accepted

## Context

Sweatpants already has a demand-pulled execution boundary:

- a Program is a passive generator of `ProgramStep` values;
- a `ProgramDriver` advances only when `ProgramPeer.step()` is called;
- `ProgramRuntime.run()` is the crank turner that repeatedly pulls the driver, records journal facts, resolves operations, and supplies the next command;
- activation coordinators fence ownership around that crank but do not define execution semantics.

A later chat-engine change introduced an eagerly spawned producer, an in-memory queue, and a signal notification behind a `Stream.next()` facade. This recreated an architecture previously rejected in repository history (`6a8b003`, “queued producer, but not the way I want”; followed by `f6c790a`, “pull based”). It added a second execution trigger and unbounded cursorless buffering.

## Decision

`ProgramRuntime.run()` is the sole crank turner and the only component allowed to consume `ProgramDriver` steps eagerly.

Everything below that boundary MUST be demand-pulled:

```text
ProgramRuntime.run
  -> ProgramPeer.attach/restore
  -> ProgramPeer.step(command)
  -> journal reserve/emit/complete
  -> effect Operation
  -> provider Stream.next()
  -> ProgramPeer.step(next command)
```

Programs, engines, drivers, effect handlers, and provider streams MUST NOT start autonomous producer loops. They advance only while their owning operation is pulled by the crank.

An activation lease coordinator MAY run ownership renewal outside the crank. It MUST NOT consume driver steps, resolve program operations, or deliver output.

## Prohibited patterns

Inside Program, engine, and ProgramDriver implementations:

- spawned producer loops;
- queue-plus-signal delivery bridges;
- event-emitter delivery;
- callback-driven model token delivery;
- timer polling for driver progress;
- a second component calling `ProgramPeer.step()`;
- hiding eager production behind a `Stream.next()` facade.

## Allowed eager boundary

A Host MAY own one logical crank-turning service. The service claims runnable journal work and invokes `ProgramRuntime.run()` under an exact activation fence. Multiple deployment workers MAY implement that logical service only when authority fencing guarantees one owner for a task activation.

## Consequences

- Driver behavior is reproducible under local, worker, and remote placement.
- Backpressure and demand semantics remain visible in the call graph.
- Compute loss cannot strand cursorless in-memory execution output.
- Live projection must be written during the crank turn to a Host-owned store rather than returned through an eager engine queue.

## Enforcement

Structural tests inspect the chat engine and ProgramDriver implementations for forbidden producer primitives. Behavioral tests prove that model providers are advanced only by a demand on the single session source and that reconnect readers do not advance program execution.
