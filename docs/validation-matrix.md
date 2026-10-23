# Validation Matrix

> **This document is the map of what Sweatpants claims and what evidence backs each claim.**
> Every cell cites a test file or evidence artifact that exists in this repo. A cell without a
> citation is an open gap, listed in [Gaps](#gaps-priority-order). PRs that fill a cell MUST
> update this document in the same change.

## Strategy: degenerate cases, not use cases

Sweatpants is validated against a small basis set of deliberately degenerate scenarios rather
than a breadth of user applications. Each case is the smallest possible instance of a primitive
that any model — of any size — can be expected to drive:

| Degenerate case | Primitive it certifies |
| --- | --- |
| **pick_card** | Single human-in-the-loop tool call: park on an elicitation, survive host death, resume with the exact accepted input |
| **book_flight** | Multi-step workflow: two sequential elicitations (flight → seat) with effects between them, decline/cancel at each stage |
| **tictactoe** | Bounded agent loop: model-driven iteration with HITL per turn and a code-decidable terminal condition |

The bet: a framework that handles these three well — under process death, with small local
models, and through third-party clients — covers the core primitives an MVP agent product needs.
What this basis set deliberately does **not** cover is recorded in
[Out of scope](#out-of-scope-for-the-basis-set).

## The two integration modes (a deliberate trust boundary)

Every degenerate case can exist on either side of a trust boundary, and the two sides validate
different claims:

- **Journal-native** (`createDurableTool`): the tool is a pinned durable program. The journal
  records its effects and elicitations; replay is deterministic; process death anywhere inside
  the tool is recoverable to the exact suspension point.
- **Foreign / ordinary** (`createTool`, MCP plugin pattern, external A2A agents): the tool
  conforms to the elicit/sampling protocols but has no journal awareness. The *conversation*
  around it stays durable; the tool itself gets weaker guarantees.

The foreign mode is not legacy debt. It is the proof that Sweatpants composes with tools and
agents **not authored in this framework** — which is the realistic shape of most integrations.
Both populations are maintained on purpose.

## Certification levels

| Level | Meaning |
| --- | --- |
| **E2E** | Real browser/HTTP transport against a running app (Playwright or HTTP acceptance test) |
| **Process replacement** | Host process SIGKILLed mid-work; a fresh process recovers from persisted journal state; evidence asserted (no re-execution, byte-identical terminal results) |
| **Third-party interop** | Driven by a pinned, independently authored client (A2A Inspector at `8098818f`, upstream Python SDK) |

## The matrix

### pick_card — single HITL park/resume

| | Journal-native | Foreign (MCP/ordinary) |
| --- | --- | --- |
| E2E | ✅ `apps/yo-a2a/e2e/a2a-inspector.spec.ts` · `apps/yo-chat/acceptance/durable-pick-card-http.acceptance.test.ts`, `durable-pick-card-worker.acceptance.test.ts` | ✅ `apps/yo-chat/e2e/pick-card.spec.ts` · `apps/yo-mcp/e2e/pick-card.spec.ts` · `apps/yo-chat/acceptance/demo-mcp-browser-elicit.acceptance.test.ts` |
| Process replacement | ✅ `apps/yo-a2a/test/process-replacement.test.ts` (SIGKILL, file journal, terminal-task byte equality) · AgentCore live evidence: `apps/agentcore-durable-program-runtime/live-evidence/` | ⬜ **Gap G1** — foreign mid-elicit death semantics untested and unspecified |
| Third-party interop | ✅ `apps/yo-a2a/e2e/a2a-inspector.spec.ts` (pinned Inspector: park → `input_required` → resume → context memory) | ✅ MCP Inspector: `apps/yo-mcp/e2e/` |

### book_flight — multi-elicit workflow

| | Journal-native | Foreign (MCP/ordinary) |
| --- | --- | --- |
| E2E | ✅ `apps/yo-chat/acceptance/book-flight-program-driver.acceptance.test.ts`, `book-flight-program-driver-http.acceptance.test.ts` (unchanged authored tool through ProgramRuntime) | ✅ `apps/yo-chat/e2e/book-flight.spec.ts` (501 lines: full flow, decline/cancel, repeat booking in one session) · `book-flight-full.spec.ts` · `src/outside-in/flows/book-flight.flow.test.ts` |
| Process replacement | ✅ `apps/yo-a2a/test/process-replacement.test.ts` ("multi-elicit workflow across two process replacements": SIGKILL while parked before flight selection *and* between the two elicitations; exactly-once reservation; post-completion continuation retry reconciles) | ⬜ **Gap G1** (same as pick_card; this is the sharpest instance) |
| Third-party interop | ⬜ | ⬜ |

### tictactoe — bounded agent loop with HITL

Two variants, on purpose: `tictactoe` uses MCP-standard plain-text sampling (dumb-model
tolerant); `play_ttt` uses structured agentic strategy.

| | Journal-native | Foreign (MCP/ordinary) |
| --- | --- | --- |
| E2E | ✅ `apps/yo-chat/acceptance/play-ttt-program-driver.acceptance.test.ts`, `play-ttt-program-driver-http.acceptance.test.ts` | ✅ `apps/yo-chat/e2e/tictactoe.spec.ts` (554 lines) · `play-ttt.spec.ts` (412) · `repro-play-ttt-twice.spec.ts` · `src/outside-in/flows/play-ttt.flow.test.ts` |
| Process replacement | ⬜ (mid-game death → resume with board state intact) | ⬜ **Gap G1** |
| Third-party interop | ⬜ | ⬜ |

### Cross-cutting certifications (not per-case)

| Claim | Evidence |
| --- | --- |
| Caller-authoritative A2A sub-agents survive process replacement | `packages/a2a` multi-process certification (`apps/a2a-review`, evidence: modelExecutions 3, consultationPulls 1, taskClosures 4) |
| Foreign A2A tasks adapt into durable programs with honest indeterminacy (`onIndeterminate: "fail"`) | `packages/a2a/src/__tests__/foreign-adapter*.test.ts` |
| Peer certification across independent journals | `342b7d4` certification suites |
| Journal-backed standard A2A host: terminal immutability, idempotency, continuation reconciliation across host replacement | `packages/agent-host/src/server/__tests__/standard-a2a-host.test.ts` |
| Content custody: put-verify-reference, loss preserves task truth | `packages/a2a/src/__tests__/content-store.test.ts` + host custody test |
| Third-party client compatibility, pinned artifact, patch-reviewed | `interop/a2a-inspector/` + `.github/workflows/a2a-inspector-interop.yml` |
| Cancellation with typed partial results | `acceptance/__tests__/tool-runtimes/in-process/cancellation-ordering.acceptance.test.ts` + durable-tool-cancellation spec suites |
| Cloud stop/resume (AgentCore microVM) | `apps/agentcore-durable-program-runtime/live-evidence/release-20260715-2148-certification.json` |
| Stream reconnect mid-turn | `packages/durable-chat-runtime/acceptance/demo-reconnect-mid-stream.acceptance.test.ts` · `apps/yo-chat/e2e/durable-chat.spec.ts` (reload mid-stream) |

## Gaps (priority order)

- **G1 — Foreign-tool death semantics are unspecified and untested.** When an ordinary
  (non-journal) tool is mid-elicitation and the host dies: what does recovery look like, what
  does the journal record, is re-elicitation possible, and what does the user see? The foreign
  *A2A* adapter answered this class of question normatively (`onIndeterminate`); the foreign
  *tool* layer has no equivalent. Requires: a normative statement in this document (or a short
  spec) plus one SIGKILL test — book_flight between elicitations is the sharpest instance.
- **G2 — Journal-native book_flight process replacement.** ✅ Closed. The certification
  immediately found a real defect: the agent harness checkpointed journal state *after*
  sending HTTP responses, so a process death after acknowledging a parked task lost it.
  Persistence now precedes acknowledgement (`packages/agent-host/src/server/testing.ts`).
- **G3 — Native tictactoe mid-game replacement.** Cheap once G2's pattern exists.
- **G4 — book_flight / tictactoe through a third-party client.** The Inspector gate currently
  exercises pick_card only (via yo-a2a). Serving book_flight through `standardA2A` would also
  exercise multi-elicit continuation over the standard protocol.

## Out of scope for the basis set

These failure classes are structurally invisible to degenerate cases and need different
artifacts (none exist yet; listed so the omission is deliberate, not accidental):

- **Scale-shaped defects**: 40-tool inventories, 200-turn journals, replay-time growth,
  retention actually expiring data. Needs a synthetic scale/longevity harness.
- **Schema and identity evolution**: what happens to *parked* work when a new release changes
  a tool's version/digest mid-elicitation. Interacts with identity provenance
  (`docs/resources-and-program-identity.md`).
- **Docs-driven usability**: has no degenerate form; its minimal test is a person who is not
  the author building tictactoe from the docs alone.

## Open questions

1. **Foreign mid-elicit recovery semantics (G1).** Fail the tool call with an explicit
   indeterminacy error (mirroring `onIndeterminate: "fail"`), or re-issue the elicitation on
   recovery? Re-issuing is user-friendly but violates at-most-once for any side effects the
   foreign tool ran before eliciting.
2. **Partial journal integration for foreign tools.** Should ordinary tools be able to opt
   into elicit-only durability (journal records the elicitation and its resolution, but not
   effects/replay)? That would let foreign tools park across process death without full
   program pinning.
3. **Identity migration vs. parked work.** Switching a tool from asserted to generated
   identity — or any digest change — orphans in-flight durable work. Drain-then-deploy is the
   implicit policy today; nothing enforces or documents it. Must be answered before the
   build-plugin (source-closure digest) work makes digest changes routine.
4. **Where does the scale harness live?** Per-app acceptance suites don't fit; a dedicated
   `apps/`-level longevity fixture probably does.
