# Live guest ownership

An authored computation yields domain requests. A Guest advances that computation
through native operations and returns Turn data. The native runner must execute
the advancement operation, not delegate directly into the authored iterator.

`createIteratorGuest(work)` is lazy: neither construction nor acquisition invokes
work. `start()` creates and first advances its iterator; `resume(outcome)` advances
only a suspended iterator. Completion and advancement failure are terminal.
Commands are checked when their operations execute. Synchronous reentrant
advancement/disposal is rejected; this driver has no asynchronous command queue.

`close()` is idempotent and invalidates the live handle. It drops the iterator
reference without calling return or throw, including before first advancement.
It never runs authored finally blocks. Those blocks can still run during normal
explicit advancement and can yield domain requests like the rest of the body.
Discarding an iterator is not a serialization or snapshot mechanism.

Native resources belong to acquisition and its surrounding lifetime. Use
`runtime.using(acquire, activate, release)` (or native scope ownership) so release
closes the Guest and releases its worker, transport or evaluator resources.
The iterator body must not acquire physical resources whose only release path is
its authored finally: disposal deliberately does not execute that code.

The live Guest/GuestWork contracts are generic in result, request and native yield.
The iterator driver needs no native yield protocol. Its reply values start unknown;
typed author declarations and domain validation must establish reply correlation.
This layer does not validate arbitrary wire bytes, accept outcomes durably, or
implement durable acceptance, replay or checkpoint capture.

Acceptance journeys in `acceptance/__tests__/execution/disposal.acceptance.test.ts`
run the same body under Effect and Effection. Scripted peers acknowledge physical
open/close and reservation requests. They verify lazy acquisition, parked disposal,
native cancellation after suspension, invalidated handles, pre-start disposal and
normal yielding finally completion with an inferred result. These are in-process
ownership checks, not crash-recovery or durable cancellation evidence.

## Logical root cancellation

`Guest.cancel` is optional evaluator support; it returns the same `Turn` union as
start/resume. The iterator implementation requires a suspended return-capable
iterator and advances `return()` once. Yielded finally requests become normal
suspended turns. Repeated cancellation preserves the current cleanup boundary;
resume supplies cleanup outcomes. Completion remains `cancelled` even when an
authored finally overrides the return value. Unhandled cleanup exceptions produce
a cancelled turn with a diagnostic failure string, not successful cleanup.

Ordinary `catch` does not receive a synthetic domain error on cancellation. Native
JavaScript nested-finally semantics apply, including continuation into outer
finally blocks after an inner failure. This does not yet implement registered
cleanup stacks, independently scheduled child tasks, or externally targeted nested
scopes. Physical close continues to discard without logical unwinding.
