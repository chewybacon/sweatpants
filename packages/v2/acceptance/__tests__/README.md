# Acceptance journeys

Add `*.acceptance.test.ts` journeys here. Exercise public package APIs through
protocol simulators running in the same process. Reusable rigs and fixtures belong
in `@sweatpan.ts/testing`. Simulate protocol peers, not internal implementation
methods. Tests own and dispose their resources and use deterministic scripted
responses and fault injection.

No unit tests, live provider calls, external services, deployed infrastructure or
subprocess-based test rigs. Recovery scenarios reconstruct the subject against
retained in-process state; they must not claim proof of real OS-process crash
recovery. Platform-specific behavior requires explicit evidence beyond a simulator.

Run `pnpm v2:test`. Empty collection intentionally fails. Add real acceptance
journeys as capabilities are ported; do not add placeholder tests or enable
`passWithNoTests`. The runtime journeys exercise shared application code through
both native adapters and an in-process scripted request/reply peer. Compile-time
acceptance fixtures additionally verify native mappings and invalid stack assembly.

## Move the entry point outward

Acceptance journeys enter through the highest implemented application boundary
that can express the behavior. As that boundary advances, migrate existing
journeys and retire their lower-level equivalents rather than accumulating a
permanent suite for every layer. Preserve behavioral and inference evidence,
not the old test shape or test count.

Durable recovery journeys now enter through `activateJournal`; replies enter
through `journal.accept`. They do not manually build accepted histories, update
recovery positions or resume Guests. Storage fault injection and protocol peers
remain below that entry point. Assembly may install middleware and evaluator
adapters without making their methods the subject's entry point.

Runtime and execution journeys remain transitional evidence for behaviors not yet
covered through application entry points: native cancellation, acquisition and
release, scope policy, unstarted disposal and multi-Guest composition. Move those
assertions outward when hosting/agent entry points can exercise them; do not keep
the lower-level journey once its replacement establishes the same behavior.

Hosted effect journeys now enter through `host.operations.run()`. Competing hosts,
late replies and lost acknowledgements are exercised there, with injected
transport behavior around the real attempt storage capability. Journal activation
remains the entry point for externally answered requests and evaluator/storage
fault journeys; handler execution belongs to hosting.

Participant interaction journeys enter through hosting as well: registration,
answering and invalidation use the public scoped API. They establish a local wait
without an execution attempt and the optional composition of external registration
followed by waiting. Invalidation tests prove reply fencing, not deadline scheduling
or logical cancellation/unwinding.
