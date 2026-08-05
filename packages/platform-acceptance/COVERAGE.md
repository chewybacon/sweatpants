# Deterministic Black-Box Confidence Matrix

This package owns framework behavior that must remain stable across refactors.
Every scenario crosses the public client/session and real provider parser; tool
scenarios also cross Program Runtime and real worker threads. The HTTP-sensitive
subset runs through a loopback server rather than a mocked fetch.

All scenarios use the causal generator authoring model documented in
[`AUTHORING.md`](./AUTHORING.md). Future coverage should extend that vocabulary
rather than introduce pre-armed promise choreography.

## Covered behavior

| Risk                                     | Black-box evidence                                                                                                                                                                                                | Bindings                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Stream pacing and terminal ordering      | Manual provider chunk release → observed client delta → finish → turn completion                                                                                                                                  | in-process + HTTP                  |
| Token journal policy                     | Exact ordered deltas, one terminal assistant journal record, no per-token journal records                                                                                                                         | in-process + HTTP                  |
| Provider rejection                       | Pre-stream HTTP/provider error yields one `RUN_ERROR`; same conversation recovers                                                                                                                                 | in-process + HTTP                  |
| Partial provider failure                 | Visible partial delta is retained in recovery history; no success terminal follows                                                                                                                                | in-process + HTTP                  |
| Provider disconnect                      | Transport ends without completion; visible partial history survives; next turn succeeds                                                                                                                           | in-process + HTTP                  |
| Empty assistant output                   | Completes without hanging or manufacturing text                                                                                                                                                                   | in-process + HTTP                  |
| Ordinary foreign/remote tool             | Real off-main-thread foreign session, two typed elicits, named nested sample, result, terminal response; HTTP binding proves the remote transport edge                                                            | in-process + HTTP                  |
| Canonical worker context                 | `ctx.messages` tracks accepted elicit/sample exchanges; named sample and three-argument notify adapter are typed                                                                                                  | real worker + direct adapter tests |
| Elicit outcomes                          | Accept, decline, and cancel produce structured results and terminal outer turns                                                                                                                                   | in-process + HTTP                  |
| Duplicate elicit response                | Second semantic response is rejected; tool resumes and samples exactly once                                                                                                                                       | in-process + HTTP                  |
| Stale settled elicit response            | A captured pending response is posted after another client settles the durable elicit; persisted settlement restores after reopen and conflicting stale input yields `RESUME_CONFLICT` without a provider request | in-process + HTTP                  |
| Durable tool                             | Native child routing, deterministic host effect, nested sample, typed elicit, park, fresh-worker replay/resume                                                                                                    | in-process + HTTP                  |
| Durable worker lifecycle                 | Parked and resumed worker attach/shutdown counts are `1/1` then `2/2`, with zero live attachments                                                                                                                 | in-process + HTTP                  |
| Durable decline/cancel                   | Both outcomes replay in a fresh worker and produce one terminal result                                                                                                                                            | in-process + HTTP                  |
| Durable host-effect failure              | Structured call/error history and same-conversation recovery                                                                                                                                                      | in-process + HTTP                  |
| Tool throw after resume                  | Error after two elicit resumptions is recorded and recoverable                                                                                                                                                    | in-process + HTTP                  |
| Nested provider failure                  | Tool-owned sample failure produces sanitized call/error history without nested prompt leakage                                                                                                                     | in-process + HTTP                  |
| Final provider failure after tool result | Successful tool result survives final sample failure and appears in recovery history                                                                                                                              | in-process + HTTP                  |
| Multiple calls in one response           | Two distinct calls execute and correlate to two results in causal order                                                                                                                                           | in-process + HTTP                  |
| Mixed ordinary/durable response          | Each call routes to its correct substrate; both results precede final sample                                                                                                                                      | in-process + HTTP                  |
| Mixed success/failure response           | Earlier successful result and later error result both survive into recovery history                                                                                                                               | in-process + HTTP                  |
| Sequential tool iterations               | Two tool iterations then terminal response; all prior call/results retained                                                                                                                                       | in-process + HTTP                  |
| Maximum iterations                       | Stable failure after configured limit; no extra provider request                                                                                                                                                  | in-process + HTTP                  |
| Invalid model arguments                  | Validation fails before tool body and conversation recovers with call/error history                                                                                                                               | in-process + HTTP                  |
| Invalid declared output                  | Output validation failure produces one error result and recovery                                                                                                                                                  | in-process + HTTP                  |
| Unknown tool target                      | Root catalog rejects with stable code after journaling call; recovery history includes error result                                                                                                               | in-process + HTTP                  |
| Malformed JSON arguments                 | Real OpenAI parser/framework path terminates once and conversation recovers                                                                                                                                       | in-process + HTTP                  |
| Split tool arguments                     | JSON arguments split into two-byte provider chunks parse and execute correctly                                                                                                                                    | in-process + HTTP                  |
| Text before tool call                    | Preface streams publicly and remains causally associated with the tool turn                                                                                                                                       | in-process + HTTP                  |
| Successful ordinary history              | User → call → result → terminal assistant → follow-up exactly once                                                                                                                                                | in-process + HTTP                  |
| Multi-turn public message timeline       | Snapshot order keeps completed ordinary/durable elicits nested under their tool message; a later user turn and pending elicit append after the prior terminal assistant; replay preserves responded elicits       | in-process + HTTP                  |
| Successful durable history               | Durable call/result exactly once; nested sample excluded                                                                                                                                                          | in-process + HTTP                  |
| Failed history                           | Call/error pair persists for ordinary and durable failures                                                                                                                                                        | in-process + HTTP                  |
| Cancel-on-send supersession              | Parked ordinary/durable task is cancelled; replacement user turn continues in one activation                                                                                                                      | in-process + HTTP                  |
| Nested durable cancellation              | Pending nested provider request is aborted; same durable conversation reopens in a fresh client session and completes                                                                                             | in-process + HTTP                  |
| Concurrent conversations                 | Interleaved streams never cross; failure in A does not affect B                                                                                                                                                   | in-process + HTTP                  |
| HTTP reconnect                           | Disconnect after first delta, reconnect from checkpoint, replay only unseen delta, model runs once                                                                                                                | HTTP                               |
| Standard A2A agent                       | Agent Card discovery and HTTP+JSON send cross both an assembled code handle and an independently hosted real-HTTP origin; the rig causally controls pi-ai sampling and verifies completed task history            | in-process + HTTP                  |
| Sub-agent composition postures           | The same authored crank-native child runs as a mounted packaged handle and through a real A2A WebSocket driver/executor; nested sample, elicit, replay, result, and final response are equivalent                 | in-process + HTTP                  |
| MCP Streamable HTTP backchannels         | Real worker-backed tool crosses `createMcpHandler`; two elicitation responses and one sampling response route into the live session before terminal result                                                        | direct Request/Response + SSE      |

## Deliberately outside this matrix

- React/browser rendering and plugin UI
- Vite bundling and generated-file freshness (kept in app/plugin boundary tests)
- Real Redis, AgentCore, WebSocket, and SigV4 semantics
- Live model/provider quality
- App-specific game/booking behavior
- Hypothetical malformed provider identities such as duplicate call IDs, unless
  production evidence or a provider contract requires a policy

## Change-safety expectation

Framework changes affecting chat orchestration, Program Runtime, provider
projection, ordinary/durable tools, cancellation, history, or response-stream
transport SHOULD keep this matrix green. New behavior should extend an existing
semantic fixture before introducing an app-local manual harness.
