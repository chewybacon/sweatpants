# Normative Specification: Caller-Authoritative A2A Program Extension and Remote Sub-Agent Runtime

## Status

Experimental v1 — published extension contract

## Abstract

This specification defines discovery, negotiation, transport, authority, replay, effect-resolution, cancellation, security, and acceptance requirements for invoking an exact remote Sweatpants program as a caller-authoritative structured child through an A2A-advertised `ProgramDriver` extension, while preserving the caller journal as the sole durable authority.

## 1. Introduction

### 1.1 Purpose

A2A normally models a server-owned task. Sweatpants also needs a distinct mode in which an A2A server advertises immutable program artifacts and supplies replaceable execution, while the calling Sweatpants journal owns child allocation, operation ordering, replay, effects, cancellation, and terminal state.

This specification defines that caller-authoritative mode. It projects the existing `ProgramDriver` contract across an authenticated network boundary without introducing a remote journal, shared state store, or second execution engine.

### 1.2 Scope

This specification covers:

- A2A Agent Card discovery and extension activation;
- exact program-manifest lookup and pinning;
- an authenticated WebSocket projection of `ProgramDriver`;
- attachment command idempotency and epoch fencing;
- ordinary and streamed-restore recovery;
- caller-side effect resolution, including `model.sample`;
- structured child cancellation;
- a clean-context, application-authored consultation acceptance vertical;
- transport, SSRF, authentication, observability, and conformance requirements.

This specification does not define foreign A2A task invocation, callee-authoritative peers, detached agents, dynamic capability escalation, Cloudflare placement, durable workspace storage, or a standard consultation effect.

### 1.3 Normative language

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are to be interpreted as described by RFC 2119 and RFC 8174 when, and only when, they appear in all capitals.

### 1.4 Terminology

- **Caller**: the Sweatpants host invoking a remote program.
- **Caller authority**: the caller-side `DurableJournalAuthorityService`.
- **Child**: the exact pinned remote program invoked by the parent.
- **Remote executor**: the authenticated service implementing the remote side of the driver protocol.
- **Local child task**: the caller-journal task allocated for the invocation.
- **Execution ID**: an opaque identity for one remote execution lineage; it contains no journal credential or raw route.
- **Attachment**: activation-scoped remote generator state identified by an `attachmentId` and execution epoch.
- **Logical outcome**: completed, failed, or canceled state committed by the caller authority.
- **Compute loss**: process, transport, sandbox, attachment, or deployment loss that has no logical outcome by itself.
- **Extension URI**: `https://github.com/chewybacon/sweatpants/blob/main/protocols/a2a/caller-authoritative-program/v1/spec.md`.
- **Canonical JSON**: the existing Sweatpants bounded canonical JSON representation and digest algorithm.

## 2. Normative requirements

### 2.1 Authority and lifecycle

#### REQ-001: Sole journal authority

A caller-authoritative invocation **MUST** use the caller’s existing journal authority as the sole authority for parent and child task allocation, operation reservation, effect resolution, emissions, cancellation, replay position, and terminal outcome. The remote executor **MUST NOT** create or write an authoritative journal for the invocation.

**Source**: DR-001

**Rationale**: One authority prevents divergent replay and duplicate accepted progress.

**Acceptance Criteria**:

- [ ] Every accepted child transition has a corresponding caller-authority operation.
- [ ] The remote executor has no API or credential permitting direct journal append.
- [ ] Deleting all remote compute leaves the caller journal sufficient for recovery.

#### REQ-002: Joined invocation only

Protocol v1 **MUST** expose remote children only through joined `invoke`. The caller authority **MUST** allocate the child deterministically from the parent pull, and the parent continuation **MUST NOT** resume before the child produces a recorded terminal outcome. Protocol v1 **MUST NOT** expose remote `spawn` or detach semantics.

**Source**: DR-002

**Rationale**: Joined ownership provides structured lifecycle semantics without expanding the initial protocol.

**Acceptance Criteria**:

- [ ] Replaying the same parent pull selects the same child task.
- [ ] Parent completion is impossible while the child invoke remains unresolved.
- [ ] No v1 API creates a detached remote child handle.

#### REQ-003: Compute loss is not a logical outcome

Remote process exit, transport loss, sandbox loss, caller-host shutdown, attachment disposal, or deployment replacement **MUST** release or expire compute resources without recording child success, failure, or cancellation.

**Source**: DR-003

**Rationale**: Infrastructure failure is recovered through replay and cannot be conflated with application state.

**Acceptance Criteria**:

- [ ] Injected transport loss produces no terminal child journal record.
- [ ] A fresh attachment can recover the same child after each listed loss.
- [ ] Shutdown paths classify the attachment as parked, transport-lost, or scope-exit rather than logically canceled.

#### REQ-004: Structured cancellation

Parent cancellation **MUST** use the existing durable one-shot cancellation and unwind semantics. The caller **MUST** send the existing `cancel` program command to a live child attachment, **MUST** drive schema-valid cleanup/partial outcomes through the caller authority, and **MUST** return the recorded typed terminal or partial outcome.

**Source**: DR-004

**Rationale**: Remote placement must preserve the established cancellation contract.

**Acceptance Criteria**:

- [ ] Duplicate parent cancellation commands produce one accepted cancellation lifecycle.
- [ ] Live remote code receives one logical cancel injection.
- [ ] Cancellation partials are validated against the pinned partial schema.

#### REQ-005: No callee-owned A2A task

Caller-authoritative invocation **MUST NOT** create, depend on, or present itself as a standard callee-owned A2A `Task`. The local child task **MUST** remain the sole durable unit of work.

**Source**: DR-005

**Rationale**: A standard A2A task would introduce a competing lifecycle authority.

**Acceptance Criteria**:

- [ ] Invocation uses extension endpoints rather than A2A `SendMessage` task creation.
- [ ] Agent Card documentation identifies the capability as an extension, not a core task binding.
- [ ] No remote task ID is required to recover the child.

### 2.2 Discovery and negotiation

#### REQ-006: Versioned extension publication

A remote executor **MUST** advertise the exact Extension URI in `AgentCapabilities.extensions`. The URI document **MUST** dereference before advertisement. Published v1 normative semantics **MUST NOT** change incompatibly; incompatible changes **MUST** use a new URI. Repository or domain movement **MUST** preserve a redirect or stable alias.

**Source**: DR-006

**Rationale**: Extension identity is its compatibility boundary.

**Acceptance Criteria**:

- [ ] The advertised URI returns the approved v1 specification.
- [ ] A breaking fixture uses a different URI and is rejected as v1.
- [ ] Redirect tests resolve the original URI without changing semantics.

#### REQ-007: Agent Card extension parameters

The extension declaration **MUST** identify protocol version `1`, an authenticated HTTPS manifest endpoint, an authenticated WSS driver endpoint, and at least one mapping from an A2A skill ID to an exact pinned program identity.

**Source**: DR-007

**Rationale**: The caller needs a closed discovery document before opening remote compute.

**Acceptance Criteria**:

- [ ] Missing required parameters invalidate the extension declaration.
- [ ] Every skill mapping contains program ID, version, and lowercase SHA-256 digest.
- [ ] Both endpoint URLs pass URL-policy validation.

#### REQ-008: Explicit activation and echo

The caller **MUST** request the exact Extension URI through the A2A `A2A-Extensions` service parameter/header. HTTPS extension responses **MUST** echo it. The WSS server’s first authenticated frame **MUST** echo the exact URI and protocol version before the caller sends attach, input, command, or replay data. Missing, ignored, or mismatched echo **MUST** fail closed. The caller **MUST NOT** fall back to another extension version or ordinary A2A task execution.

**Source**: DR-008

**Rationale**: Explicit activation prevents accidental use of incompatible semantics.

**Acceptance Criteria**:

- [ ] Correct HTTP and first-frame echoes permit negotiation.
- [ ] Missing or wrong echoes close the connection before private payload transmission.
- [ ] No fallback request is emitted after failure.

#### REQ-009: Exact manifest validation before allocation

Before allocating the local child, the caller **MUST** resolve and validate the exact program ID, semantic version, program digest, input schema digest, output schema digest, declared effect definitions, cancellation schemas, retry-safety contracts, and replay capabilities.

**Source**: DR-009

**Rationale**: Child identity and schemas must be fixed before they enter durable history.

**Acceptance Criteria**:

- [ ] Any identity, schema, effect, or capability mismatch fails before child allocation.
- [ ] The accepted manifest passes existing `validateDurableManifest` rules.
- [ ] The caller retains all exact schema validators needed by the child.

#### REQ-010: Invocation pinning

After allocation, Agent Card, endpoint, skill mapping, or manifest changes **MUST NOT** change the child’s recorded program identity, contracts, route, or protocol version.

**Source**: DR-010

**Rationale**: Replay must not renegotiate against mutable discovery state.

**Acceptance Criteria**:

- [ ] Updating the Agent Card during a parked child does not alter recovery identity.
- [ ] Recovery uses the originally pinned manifest and endpoint policy.
- [ ] Unavailable original artifacts produce a typed unavailable error rather than substitution.

#### REQ-011: Sensitive inventory access

A public Agent Card **MAY** advertise the extension. Sensitive program inventories **MUST** be obtained through the authenticated Extended Agent Card mechanism or an equivalently authenticated manifest endpoint, and authorization **MUST** be evaluated for the requested skill/program.

**Source**: DR-011

**Rationale**: Discovery must not disclose private programs or create an authentication bypass.

**Acceptance Criteria**:

- [ ] Unauthorized inventory requests are denied without confirming hidden program existence.
- [ ] Authorized callers receive only programs permitted to their identity.
- [ ] Credentials are transmitted outside Agent Card content.

#### REQ-012: Discovery sources

The implementation **SHOULD** accept an explicitly supplied Agent Card document, an explicitly supplied Agent Card URL, and the standard `/.well-known/agent-card.json` location. Registry search **MAY** remain unsupported.

**Source**: DR-012

**Rationale**: Direct and well-known discovery cover the first vertical without marketplace scope.

**Acceptance Criteria**:

- [ ] Explicit document and URL discovery produce the same canonical card digest.
- [ ] Well-known discovery works for an allowed HTTPS origin.
- [ ] Unsupported registry discovery is documented and does not affect direct configuration.

### 2.3 Remote ProgramDriver

#### REQ-013: Driver semantic parity

The caller adapter **MUST** implement exact manifest lookup, attach, ordered step, shutdown, and ordinary replay semantics of `ProgramDriver`. If streamed restore is advertised, it **MUST** implement the existing restore and restore-context semantics. Authored child program code **MUST NOT** depend on whether its driver is local, AgentCore, or this extension.

**Source**: DR-013

**Rationale**: Remote A2A placement is an adapter, not a second execution model.

**Acceptance Criteria**:

- [ ] Provider-neutral driver fixtures pass through the remote adapter.
- [ ] The same child program runs locally and remotely without source changes.
- [ ] Unsupported optional restore is reported without breaking ordinary replay.

#### REQ-014: Deployment-selected child routing

`ProgramRouteResolverContext` **MUST** select the remote route for an advertised child identity. Nested programs and effects not selected for the remote route **MUST** remain under caller deployment policy.

**Source**: DR-014

**Rationale**: Program code declares structure while deployment chooses placement.

**Acceptance Criteria**:

- [ ] The selected child uses the extension driver.
- [ ] A caller-local nested child/effect remains local.
- [ ] Route selection is deterministic for the pinned child identity.

#### REQ-015: Closed wire projection

The wire protocol **MUST** use the closed envelope and payload algebra in Section 4. It **MUST NOT** serialize caller-private `ProgramRoute` fields, journal/session credentials, capability-keyring material, cloud placement credentials, or runtime-only attachment handles.

**Source**: DR-015

**Rationale**: Local driver objects cross a new trust boundary only through an explicit projection.

**Acceptance Criteria**:

- [ ] Unknown envelope and payload fields are rejected.
- [ ] Serialization tests prove prohibited private values are absent.
- [ ] Runtime attachment handles throw or fail serialization.

#### REQ-016: Envelope identity binding

Every post-handshake wire envelope **MUST** bind the Extension URI, protocol version, opaque execution ID, exact pinned program identity, execution epoch, and message type. Attachment-scoped envelopes **MUST** also bind `attachmentId`; action-scoped envelopes **MUST** also bind `actionIndex` and stable `commandId`.

**Source**: DR-016

**Rationale**: Complete identity prevents cross-task, stale-epoch, and cross-attachment confusion.

**Acceptance Criteria**:

- [ ] Omitting or changing any required identity rejects the frame.
- [ ] A frame from another execution/attachment cannot advance the child.
- [ ] Canonical identity participates in command and frontier digests.

#### REQ-017: Attachment-scoped command idempotency

For each ordered command, the remote executor **MUST** produce exactly one schema-valid `ProgramStep`. For the lifetime of the attachment, it **MUST** retain the accepted command ID, canonical command digest, and returned step. An exact duplicate **MUST** return the same step; conflicting reuse **MUST** return `idempotency_conflict`; neither case may advance the generator twice. Retention **MAY** end after acknowledged attachment shutdown.

**Source**: DR-017

**Rationale**: Network retries must not create duplicate generator advancement.

**Acceptance Criteria**:

- [ ] Exact command duplicates return byte-equivalent canonical steps.
- [ ] Same ID with different content is rejected.
- [ ] A new attachment recovers by replay rather than old command retention.

#### REQ-018: Authority validation of proposals

The remote executor **MUST** return proposals only. The caller authority **MUST** validate every proposal through existing reserve, resolve, emit, and complete boundaries. The remote executor **MUST NOT** mint resolution receipts, effect authorization, journal offsets, or accepted terminal state.

**Source**: DR-018

**Rationale**: Remote compute is untrusted with respect to durable state transitions.

**Acceptance Criteria**:

- [ ] A fabricated receipt/offset is rejected as an unknown or forbidden field.
- [ ] Schema-invalid and nondeterministic proposals fail at the caller authority.
- [ ] Only caller-generated receipts are sent on resume/ack commands.

#### REQ-019: Stale identity fencing

A stale execution epoch, attachment identity, command identity, action index, program identity, replay position, replay-chain digest, or frontier digest **MUST** be rejected before its result can advance the caller journal.

**Source**: DR-019

**Rationale**: Old compute must not win after takeover or restore.

**Acceptance Criteria**:

- [ ] Each stale dimension is independently rejected in negative tests.
- [ ] A higher-epoch attachment can progress after stale rejection.
- [ ] No rejected stale step produces a semantic journal record.

#### REQ-020: Connection-independent recovery

Transport disconnection **MUST** be recoverable by creating a fresh attachment and replaying caller-authoritative history. A WebSocket connection **MUST NOT** be persisted or treated as durable task state.

**Source**: DR-020

**Rationale**: Long-lived tasks cannot depend on one connection or process.

**Acceptance Criteria**:

- [ ] Closing the socket at every command boundary permits recovery.
- [ ] Recovery on another host reaches the same next proposal.
- [ ] No live socket handle appears in durable snapshots.

#### REQ-021: Streamed restore optimization

The remote driver **SHOULD** implement streamed restore with replay-chain and frontier-digest verification. If it does not, ordinary crank replay **MUST** remain correct. A driver **MUST NOT** advertise streamed restore unless it passes the restore conformance suite.

**Source**: DR-021

**Rationale**: Streamed restore improves long-history performance without changing correctness.

**Acceptance Criteria**:

- [ ] Streamed restore passes valid history and rejects tampering/gaps.
- [ ] Disabling streamed restore still recovers through ordinary replay.
- [ ] Capability advertisement matches implementation behavior.

#### REQ-022: Payload and replay bounds

Every canonical wire frame **MUST** be at most 2 MiB. Child input **MUST** satisfy both the existing 1 MiB authority inline bound and the frame bound before child allocation or attachment. Streamed restore **MUST** transmit exactly one bounded replay entry per replay frame. Oversized input, entry, or frame **MUST** fail as `payload_too_large` without truncation.

**Source**: DR-022

**Rationale**: Deterministic bounds prevent partial allocation and unbounded buffering.

**Acceptance Criteria**:

- [ ] Boundary-sized frames succeed and one-byte-oversized frames fail.
- [ ] Oversized child input allocates no child and opens no attachment.
- [ ] Restore never batches multiple entries into one replay payload.

### 2.4 Effects and caller custody

#### REQ-023: Exact declared effects

Every effect a child may propose **MUST** appear in its pinned manifest with exact name, version, input descriptor, output descriptor, optional cancellation-partial descriptor, and retry-safety contract.

**Source**: DR-023

**Rationale**: The caller authority needs exact contracts before any effect request.

**Acceptance Criteria**:

- [ ] Undeclared effect proposals are rejected.
- [ ] Every descriptor digest and retry policy is present in the manifest.
- [ ] Cancellation partial validation selects the exact pinned descriptor.

#### REQ-024: Handler preflight

Before child execution, the caller **MUST** install a handler and runtime validators satisfying every child effect contract. Missing, version-mismatched, digest-mismatched, or retry-incompatible handlers **MUST** fail before effect dispatch.

**Source**: DR-024

**Rationale**: Remote work must not begin under an unusable caller environment.

**Acceptance Criteria**:

- [ ] Each mismatch category fails deterministically.
- [ ] No handler invocation occurs after failed preflight.
- [ ] Matching registrations pass existing effect-registry validation.

#### REQ-025: Dual boundary schema validation

Effect input **MUST** be validated/canonicalized by the caller authority at reservation, and the committed outcome **MUST** be validated against the exact output or cancellation-partial schema before child resumption.

**Source**: DR-025

**Rationale**: Remote proposals and host handlers are both untrusted until authority acceptance.

**Acceptance Criteria**:

- [ ] Invalid input never reaches a handler.
- [ ] Invalid output never resumes the child.
- [ ] Replay uses the recorded canonical value without rerunning schema transforms.

#### REQ-026: Caller-side effect placement

Protocol v1 **MUST** resolve every child effect at the caller. This includes model sampling represented by `model.sample`. The remote executor **MUST NOT** receive model-provider credentials, caller-effect credentials, or authority to commit an authenticated operation.

**Source**: DR-026

**Rationale**: Caller-side placement is the first vertical’s credential-custody and policy boundary.

**Acceptance Criteria**:

- [ ] `model.sample` executes through the caller effect registry.
- [ ] Remote environment inspection finds no caller model/API secrets.
- [ ] Remote code can only propose, not commit, a privileged operation.

#### REQ-027: Pinned resolver route

For each effect occurrence, the caller authority **MUST** journal the selected resolver audience and route before dispatch. After an ambiguous dispatch, the system **MUST NOT** switch to another handler, route, or authority.

**Source**: DR-027

**Rationale**: Failover after ambiguity can duplicate consequential effects.

**Acceptance Criteria**:

- [ ] Replay selects the originally recorded route.
- [ ] Config changes during a parked effect do not reroute it.
- [ ] Ambiguous execution returns/parks according to retry safety rather than falling back.

#### REQ-028: Disclosure boundary

Documentation and APIs **MUST** state that returning an effect result discloses that result to the remote child. They **MUST NOT** claim control over the child’s subsequent use of disclosed data. They **MAY** claim caller custody and mediation of credentials, policy, approval, and execution.

**Source**: DR-028

**Rationale**: Credential isolation is not an information-flow guarantee.

**Acceptance Criteria**:

- [ ] Public security documentation contains the disclosure statement.
- [ ] No credential value appears in the remote effect request/result unless it is intentionally result data.
- [ ] Security tests distinguish custody from downstream data handling.

### 2.5 Reference authored-effect vertical

#### REQ-029: Protocol-agnostic effect transport

The extension and driver **MUST** remain agnostic to effect names and application meaning. A consultation request **MUST** cross the wire only as an ordinary `EffectDescriptor` proposal and return only as the recorded `OperationOutcome`; the driver **MUST NOT** contain consultation-specific branches.

**Source**: DR-029

**Rationale**: Generic effects should express reverse consultation without new protocol primitives.

**Acceptance Criteria**:

- [ ] The same transport passes consultation and an unrelated fixture effect.
- [ ] Protocol schemas contain no consultation-specific message type.
- [ ] Removing the consultation application leaves the driver functional.

#### REQ-030: Application-authored consultation contract

The acceptance application **MUST** author its consultation feature as an existing `EffectDefinition` with application-owned portable input, output, optional cancellation, and retry-safety descriptors.

**Source**: DR-030

**Rationale**: Consultation semantics belong to the product/application layer.

**Acceptance Criteria**:

- [ ] The effect passes ordinary manifest and schema validation.
- [ ] Changing its schema requires changing its application contract identity/version.
- [ ] The A2A extension remains unchanged.

#### REQ-031: No consultation protocol surface

Implementation of the acceptance vertical **MUST NOT** require a consultation-specific wire message, task state, endpoint, Agent Card field, extension URI, journal operation, or session-kernel primitive.

**Source**: DR-031

**Rationale**: The architecture should demonstrate composition from existing primitives.

**Acceptance Criteria**:

- [ ] Repository search finds no consultation branch in protocol/kernel packages.
- [ ] The feature is removable as application code.
- [ ] All durable behavior maps to child invocation, effects, elicitation, and replay.

#### REQ-032: Application-owned consultation policy

The acceptance application **MUST** own consultation scope, question budget, context selection, disclosure rules, non-answer behavior, and escalation policy. The generic adapter **MUST NOT** impose or interpret those policies.

**Source**: DR-032

**Rationale**: Different applications need different consultation semantics.

**Acceptance Criteria**:

- [ ] Policy changes require no driver/protocol changes.
- [ ] Budget and disclosure denial occur in the application handler.
- [ ] Adapter logs treat the effect generically.

#### REQ-033: Clean initial context

The reviewer child’s initial model context **MUST** contain only explicitly supplied artifacts, instructions, and rubric. Parent transcript/context **MUST NOT** be copied implicitly. Parent information delivered later **MUST** arrive as a recorded application-effect output.

**Source**: DR-033

**Rationale**: The proving vertical requires an independently formed second opinion.

**Acceptance Criteria**:

- [ ] Child context inspection contains no undeclared parent transcript.
- [ ] A targeted answer appears only after a corresponding recorded effect.
- [ ] Replay returns that answer without copying additional context.

#### REQ-034: Durable context selection

The acceptance application **MUST** durably identify the caller context or sources visible to its consultation handler before answering. Recovery **MUST NOT** silently select a different context.

**Source**: DR-034

**Rationale**: Stable evidence prevents nondeterministic or contaminated review.

**Acceptance Criteria**:

- [ ] The selected context/source digest is persisted.
- [ ] Updating parent context during the review does not silently affect the answer.
- [ ] Missing selected context produces a typed non-answer/failure.

#### REQ-035: Consultation answer idempotency

The authored handler **MUST** use the child effect pull ID as its idempotency or reconciliation identity. Once recorded, replay **MUST** return the same effect outcome without regenerating an answer or repeating user elicitation.

**Source**: DR-035

**Rationale**: Model answers and human questions are consequential effects.

**Acceptance Criteria**:

- [ ] Process death after answer commit produces no second model sample.
- [ ] Process death after user response produces no second elicitation.
- [ ] Duplicate handler delivery returns the original outcome.

#### REQ-036: No parent-generator reentrancy

The parent generator parked at `invoke()` **MUST NOT** be re-entered to answer the child. The application **MUST** resolve consultation through an independently runnable caller-side handler or durable session.

**Source**: DR-036

**Rationale**: Generator reentrancy would violate ordered action semantics and can deadlock.

**Acceptance Criteria**:

- [ ] Parent action index does not advance while consultation resolves.
- [ ] Handler can park/resume while parent remains joined on the child.
- [ ] Reentrancy attempts fail in a targeted test.

#### REQ-037: Explicit user escalation

Escalation from consultation to user elicitation **MUST** be explicitly enabled by application policy. The authored handler **MAY** elicit when enabled. The remote driver **MUST NOT** inspect or distinguish sampling, retrieval, user elicitation, or decline inside the handler.

**Source**: DR-037

**Rationale**: Human interruption is product policy, not transport behavior.

**Acceptance Criteria**:

- [ ] Disabled escalation produces a typed non-answer without elicitation.
- [ ] Enabled escalation parks and later resumes durably.
- [ ] Driver wire traces remain ordinary effect traffic in both cases.

#### REQ-038: Typed non-answer outcomes

The application effect schema **MUST** represent non-answer outcomes for unavailable context, policy denial, exhausted budget, and user decline/cancel where applicable. These conditions **MUST NOT** leave the child indefinitely pending or broaden access implicitly.

**Source**: DR-038

**Rationale**: Expected policy outcomes should be values, not stranded sessions.

**Acceptance Criteria**:

- [ ] Each expected condition returns a schema-valid non-answer.
- [ ] The child receives no additional context after denial.
- [ ] No condition leaves an unresolved effect without explicit policy.

#### REQ-039: Narrow reference answers

The reference consultation handler **SHOULD** answer only the targeted question, avoid volunteering the parent’s final conclusion, and include source references when the configured context provider supports them.

**Source**: DR-039

**Rationale**: Narrow answers preserve reviewer independence.

**Acceptance Criteria**:

- [ ] Reference prompts instruct narrow factual response.
- [ ] Source-capable fixtures return references.
- [ ] The acceptance review remains usable when references are unavailable.

#### REQ-040: Optional UI projection

Applications **MAY** expose authored-effect progress and provenance in the parent UI. Such UI projection **MUST NOT** add progress events to the child model context unless the application explicitly authors them as child input.

**Source**: DR-040

**Rationale**: Observability should not accidentally contaminate model context.

**Acceptance Criteria**:

- [ ] UI progress can be enabled without changing child messages.
- [ ] Disabled UI projection does not alter effect behavior.
- [ ] Explicitly authored child input remains possible.

### 2.6 Authentication, security, observability, and proof

#### REQ-041: Uniform authentication and authorization

Agent Card retrieval when protected, Extended Agent Card retrieval, manifest lookup, WebSocket upgrade, and every extension operation **MUST** enforce the Agent Card’s authentication and authorization policy. The extension **MUST NOT** create an unauthenticated side channel.

**Source**: DR-041

**Rationale**: Program execution and inventory are privileged resources.

**Acceptance Criteria**:

- [ ] Missing/invalid credentials fail at every protected endpoint.
- [ ] Authorization is checked per requested skill/program.
- [ ] WSS and HTTPS use equivalent principal/tenant policy.

#### REQ-042: Untrusted-input validation

All remote cards, extension parameters, manifest documents, handshake frames, envelopes, program steps, errors, application consultation inputs, and application outcomes **MUST** be treated as untrusted, bounded, and schema validated before use.

**Source**: DR-042

**Rationale**: Both remote executor and application content cross trust boundaries.

**Acceptance Criteria**:

- [ ] Fuzzed malformed and unknown fields fail closed.
- [ ] Oversized content fails before allocation or state mutation.
- [ ] Validation errors do not expose secrets or stack traces.

#### REQ-043: Correlated safe observability

Logs and traces **MUST** correlate caller session/task, execution ID, child program digest, execution epoch, attachment ID, action index, effect pull ID, and reference consultation question/effect ID. Logs **MUST NOT** include credentials, keyring material, private route data, full parent context, or unrestricted effect payloads by default.

**Source**: DR-043

**Rationale**: Operators need causal debugging without secret/context leakage.

**Acceptance Criteria**:

- [ ] One invocation can be followed across caller and executor logs.
- [ ] Secret/context fixtures are absent from default logs.
- [ ] Redaction applies to errors and protocol rejection diagnostics.

#### REQ-044: Multi-process fault certification

The acceptance vertical **MUST** run caller and remote executor in independent processes, kill each at controlled boundaries, resume with fresh processes, and prove that child allocation, `model.sample`, consultation questions/answers, user responses, and terminal results are not accepted twice.

**Source**: DR-044

**Rationale**: Process-local tests cannot certify remote durability.

**Acceptance Criteria**:

- [ ] Fault matrix covers pre-send, post-send, pre-commit, post-commit, park, restore, and terminal boundaries.
- [ ] Each semantic operation has one accepted journal outcome.
- [ ] Fresh-process recovery reaches the expected terminal review.

#### REQ-045: Clean-context review acceptance vertical

The acceptance application **MUST** give a reviewer only a design artifact and rubric, **MUST** have it ask at least one caller question through an authored effect, **MUST** support an enabled user-escalation fixture, and **MUST** return an independent review that the parent joins.

**Source**: DR-045

**Rationale**: The vertical makes the generic architecture useful and externally legible.

**Acceptance Criteria**:

- [ ] The complete workflow succeeds without failures.
- [ ] The child starts without parent transcript.
- [ ] The journal trace shows child invoke, generic effect, optional elicit, and joined result.

#### REQ-046: Reusable conformance harness

The implementation **SHOULD** expose a provider-neutral remote-executor conformance harness reusable by additional executors and Cloudflare placement.

**Source**: DR-046

**Rationale**: Backend certification should be executable rather than duplicated prose.

**Acceptance Criteria**:

- [ ] Local/reference and A2A executors run the same semantic cases.
- [ ] Driver-specific setup is supplied through a factory/port.
- [ ] Protocol and fault cases report stable backend-neutral failures.

### 2.7 Operational hardening

#### REQ-047: Finite progress deadlines

The caller-side driver **SHOULD** enforce finite deployment-configurable deadlines for handshake, attach, step response, and restore progress. Deadline expiry **MUST** close the attachment as `transport_lost`, emit safe diagnostics, record no logical outcome, and leave the task recoverable through fresh attachment/replay.

**Source**: DR-047

**Rationale**: A connected but stalled executor must not strand work indefinitely.

**Acceptance Criteria**:

- [ ] Configured deadline fixtures close stalled operations.
- [ ] No timeout fixture writes a terminal child outcome.
- [ ] Recovery after timeout succeeds on a healthy executor.

#### REQ-048: Remote zombie cleanup

When the executor accepts a newer execution epoch for an execution ID, it **SHOULD** terminate or fence older attachments for that execution ID. Caller-authority epoch validation **MUST** remain the correctness boundary even when remote cleanup is delayed.

**Source**: DR-048

**Rationale**: Remote cleanup reduces wasted compute while preserving safety independently.

**Acceptance Criteria**:

- [ ] New epoch causes old attachment shutdown or stale rejection.
- [ ] Old results remain rejected at caller authority if cleanup fails.
- [ ] Resource metrics expose lingering stale attachments.

#### REQ-049: URL and SSRF policy

Agent Card and manifest retrieval **MUST** use HTTPS, except explicitly configured loopback localhost tests. The client **MUST** allow at most three redirects, revalidate scheme/origin/IP policy after every redirect and DNS resolution, reject HTTPS-to-HTTP downgrade, require manifest/driver endpoints to share the Agent Card origin by default, and reject private, loopback, link-local, multicast, reserved, or cross-origin targets unless an explicit deployment allowlist permits them.

**Source**: DR-049

**Rationale**: Discovery URLs are attacker-controlled SSRF inputs.

**Acceptance Criteria**:

- [ ] Public same-origin HTTPS succeeds.
- [ ] Disallowed schemes, addresses, redirect count, downgrade, rebinding, and cross-origin endpoints fail before request data is sent.
- [ ] Explicit allowlist and localhost-test exceptions are scoped and auditable.

## 3. Interfaces

### 3.1 Agent Card extension parameters

The Extension URI identifies this v1 profile. `AgentExtension.params` has this closed shape:

```ts
interface CallerAuthoritativeProgramExtensionParamsV1 {
  protocolVersion: 1;
  manifestEndpoint: string; // absolute HTTPS URL
  driverEndpoint: string; // absolute WSS URL
  programs: Array<{
    skillId: string;
    program: {
      id: string;
      version: string;
      digest: string; // lowercase SHA-256 hex
    };
  }>;
}
```

`programs` contains at least one entry, `skillId` is unique within the declaration, and unknown fields invalidate the declaration. Sensitive mappings may appear only in the authenticated Extended Agent Card.

### 3.2 Manifest endpoint

The manifest endpoint is an authenticated `GET` endpoint. Query fields are `id`, `version`, and `digest`; all are required and exact. Requests carry `A2A-Extensions: <Extension URI>`. A successful response carries the same header and this closed canonical JSON document:

```ts
interface RemoteProgramManifestDocumentV1 {
  protocolVersion: 1;
  extensionUri: string;
  program: { id: string; version: string; digest: string };
  manifest: DurableProgramManifest;
  manifestDigest: string;
  capabilities: {
    ordinaryReplay: true;
    streamedRestore: boolean;
  };
}
```

`manifestDigest` is SHA-256 over the canonical `manifest`. The `manifest` program identity equals `program` exactly.

### 3.3 Driver handshake

The caller opens `driverEndpoint` with WebSocket upgrade authentication and the `A2A-Extensions` header. The first server data frame is:

```ts
interface ExecutorHelloV1 {
  type: "hello";
  protocolVersion: 1;
  extensionUri: string;
  executorId: string;
  maxFrameBytes: 2097152;
  capabilities: { streamedRestore: boolean };
}
```

The caller sends no protocol payload before validating this frame.

### 3.4 Common envelope

Every later frame is closed canonical JSON:

```ts
interface ProgramEnvelopeV1<TType extends string, TPayload> {
  protocolVersion: 1;
  extensionUri: string;
  executionId: string;
  program: { id: string; version: string; digest: string };
  executionEpoch: number; // positive safe integer
  type: TType;
  attachmentId?: string;
  actionIndex?: number;
  commandId?: string;
  payload: TPayload;
}
```

Unknown fields, noncanonical values, invalid IDs, unsafe integers, and oversized frames produce a protocol rejection.

### 3.5 Attach flow

Client messages:

```ts
type AttachBeginV1 = ProgramEnvelopeV1<
  "attach_begin",
  {
    input: Json;
    inputDigest: string;
  }
>;

type ProgramCommandFrameV1 = ProgramEnvelopeV1<
  "command",
  {
    command: ProgramCommand;
  }
>;

type ShutdownFrameV1 = ProgramEnvelopeV1<
  "shutdown",
  {
    reason: ProgramShutdownReason;
  }
>;
```

Server messages:

```ts
type AttachmentReadyV1 = ProgramEnvelopeV1<
  "attachment_ready",
  {
    attachmentId: string;
    computeGeneration: string;
  }
>;

type StepFrameV1 = ProgramEnvelopeV1<
  "step",
  {
    step: ProgramStep;
  }
>;

type ShutdownCompleteV1 = ProgramEnvelopeV1<"shutdown_complete", Record<string, never>>;
```

`attachment_ready` establishes the attachment ID used by all later attachment frames. A start command follows attach readiness. Every command frame contains a stable `commandId`; action-scoped commands repeat `actionIndex` in the envelope and command payload consistently.

### 3.6 Streamed restore flow

Client messages:

```ts
type RestoreBeginV1 = ProgramEnvelopeV1<
  "restore_begin",
  {
    input: Json;
    inputDigest: string;
    replayedThroughActionIndex: number;
    replayChainSeed: string;
  }
>;

type ReplayOperationFrameV1 = ProgramEnvelopeV1<"replay_operation", ReplayOperationEntry>;

type ReplayEmissionFrameV1 = ProgramEnvelopeV1<"replay_emission", ReplayEmissionEntry>;

type ReplayEndV1 = ProgramEnvelopeV1<
  "replay_end",
  {
    entryCount: number;
    replayChainDigest: string;
  }
>;
```

Server messages:

```ts
type RestoreReadyV1 = ProgramEnvelopeV1<
  "restore_ready",
  {
    attachmentId: string;
    computeGeneration: string;
  }
>;

type FrontierV1 = ProgramEnvelopeV1<
  "frontier",
  {
    step: ProgramStep;
    replayedThroughActionIndex: number;
    replayChainDigest: string;
    frontierDigest: string;
  }
>;
```

The server returns `restore_ready`, consumes exactly one replay entry per replay frame, validates the chain, consumes `replay_end`, and returns one frontier. No live command is accepted before the frontier is validated and bound by the caller authority.

### 3.7 Rejection frame

```ts
type RejectedV1 = ProgramEnvelopeV1<
  "rejected",
  {
    code: ProtocolErrorCode;
    message: string;
  }
>;
```

The error message is bounded safe text and does not include stack traces, credentials, private routes, or unrestricted payloads.

### 3.8 Command identity

`commandId` is an opaque stable identifier derived from execution ID, epoch, attachment ID, command type, and action index or command-specific identity. The executor stores:

```ts
interface AcceptedCommandRecordV1 {
  commandId: string;
  commandDigest: string;
  responseType: "step" | "shutdown_complete";
  responseDigest: string;
  canonicalResponse: Json;
}
```

Retention is attachment-scoped and ends only after acknowledged shutdown or attachment reclamation.

### 3.9 Reference application API

The reference application exposes an `ask_parent` model tool backed by an application `EffectDefinition`. Its exact name and schemas are not protocol data. The minimum application behavior is equivalent to:

```ts
type ReferenceConsultationResult =
  | { status: "answered"; answer: string; source?: string }
  | { status: "unknown"; reason?: string }
  | { status: "declined"; reason?: string };
```

This shape is illustrative for the reference application and is not an A2A extension contract.

## 4. Error handling

### 4.1 Error codes

```ts
type ProtocolErrorCode =
  | "agent_card_invalid"
  | "unsafe_url"
  | "authentication_failed"
  | "authorization_denied"
  | "extension_not_advertised"
  | "extension_not_activated"
  | "extension_echo_mismatch"
  | "protocol_version_unsupported"
  | "manifest_not_found"
  | "manifest_mismatch"
  | "program_version_unavailable"
  | "schema_version_unavailable"
  | "effect_handler_missing"
  | "effect_contract_mismatch"
  | "identity_mismatch"
  | "stale_activation"
  | "idempotency_conflict"
  | "payload_too_large"
  | "replay_diverged"
  | "history_not_exhausted"
  | "program_protocol_error"
  | "deadline_exceeded"
  | "transport_lost";
```

### 4.2 Recovery classes

| Error                                                           | State mutation                               | Recovery                                                                  |
| --------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| Discovery/auth/manifest/contract errors                         | No child allocation or effect dispatch       | Correct configuration/authentication; retry discovery                     |
| `payload_too_large`                                             | No oversized transition accepted             | Externalize/reduce payload; do not truncate                               |
| `identity_mismatch`, `stale_activation`, `idempotency_conflict` | Rejected                                     | Do not retry under a fresh identity; investigate stale/conflicting caller |
| `replay_diverged`, `history_not_exhausted`                      | No live frontier accepted                    | Close attachment; quarantine executor/release; do not continue            |
| `deadline_exceeded`, `transport_lost`                           | No logical terminal outcome                  | Close attachment and recover through fresh attachment/replay              |
| `program_version_unavailable`, `schema_version_unavailable`     | Task remains pinned and recoverable/stranded | Restore exact artifact; never substitute another version                  |

## 5. Security considerations

- The manifest and WSS endpoints are privileged execution surfaces and use the Agent Card’s authentication policy.
- The SSRF policy in REQ-049 applies before every fetch, redirect, DNS resolution, and WebSocket connection.
- Remote executor data is untrusted even after authentication.
- Execution IDs, command IDs, and attachment IDs are opaque correlation identities, not authorization credentials.
- Caller capability tokens, keyring secrets, journal IDs, private routes, model credentials, and effect credentials never cross the driver boundary.
- The remote executor receives effect results intentionally; this is disclosure to the child.
- Default logs contain digests and safe IDs rather than full model context or effect payloads.
- A compromised executor can propose malicious work or misuse disclosed data, but cannot commit journal progress or privileged effects without caller-authority and caller-handler validation.

## 6. Compatibility and versioning

- Protocol version `1` is identified by the exact Extension URI and `protocolVersion: 1`.
- Additive optional fields are not permitted inside v1 closed wire objects unless this specification is compatibly revised to declare them.
- Breaking field, state-machine, identity, digest, or retry changes require a new extension URI and protocol version.
- Existing local and AgentCore `ProgramDriver` semantics remain unchanged.
- Existing `spawn`/`join` authoring APIs remain available outside this profile but are not projected remotely by v1.
- Historical child tasks retain their original program, manifest, schema, endpoint policy, and protocol pins.

## 7. Traceability matrix

| Design requirement | Normative requirement |
| ------------------ | --------------------- |
| DR-001–DR-005      | REQ-001–REQ-005       |
| DR-006–DR-012      | REQ-006–REQ-012       |
| DR-013–DR-022      | REQ-013–REQ-022       |
| DR-023–DR-028      | REQ-023–REQ-028       |
| DR-029–DR-040      | REQ-029–REQ-040       |
| DR-041–DR-046      | REQ-041–REQ-046       |
| DR-047–DR-049      | REQ-047–REQ-049       |

Every design requirement maps one-to-one to the requirement with the same numeric suffix.

## References

- Approved design: `.pi/specs/caller-authoritative-a2a-subagents-design.md`
- Design provenance session: `019f6aca-c969-72ee-af68-9898ce6eaee9`
- Reserved extension URI stub: `sweatpants/protocols/a2a/caller-authoritative-program/v1/spec.md`
- A2A v1 source reviewed at commit `4374b824a9cfdf55a086cc0ae525aab7008e0e3a`
- RFC 2119, “Key words for use in RFCs to Indicate Requirement Levels”
- RFC 8174, “Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words”
