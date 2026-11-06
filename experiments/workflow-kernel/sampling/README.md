# Sandbox sampling through effects

A bounded assembly experiment, not a promoted sampling package or compiler frontend.
The prior linked-workflow slice is checkpointed at `c0c27084`.

## What runs

A two-round rock-paper-scissors workflow requests a model move, validates it in pure
code, asks for the player's move, computes the winner, and loops. Both a normal typed
v2 tool body and a Scheme sandbox program use the same module-level effect declaration,
request/result schemas and domain Outcome. The Scheme version captures/restores its
continuation; the native tool version replays accepted effects. Neither reissues an
accepted sample when the journal is reopened.

```ts
const sampled = yield * ctx.capabilities.sample({ prompt: "Choose a move." });
if (sampled.ok) {
  const text = sampled.value.text;
}
```

```scheme
(let ((sampled (sample (object (list "prompt" "Choose a move.")))))
  (if (json-field sampled "ok")
    (json-field (json-field sampled "value") "text")
    "sample rejected"))
```

The shared contract is intentionally text-only:

- Request: `prompt`, optional `systemPrompt`, explicit text `history`, and `maxTokens`.
- Success: `text`, host-selected `{id, provider, api}`, and nullable `responseId`.
- Domain result: the existing `Outcome`; thrown provider failures are delivery errors,
  not manufactured domain failures or automatic retries.

No model, endpoint, credential, callable tool, arbitrary generation option or schema
comes from the Guest. Unknown request fields reject. No outer conversation, player
answer, private variables or reasoning history is implicitly included in a sample.
Explicit prior user/assistant text can be supplied. The original text game separately rejects non-move text without retrying or opening
an elicitation. The structured variant below validates a registered JSON shape.

## Existing boundaries used

1. `contracts.mts` declares ordinary `defineEffect` values. Importing them grants
   no authority and creates no runtime or provider.
2. `game.mts` declares a native `defineTool` with a sample capability and move elicit,
   plus equivalent Scheme caller source. No mandatory `ctx.sample` method is added.
3. `scheme.mts` admits bounded caller syntax using the existing linked experiment
   helper and registers `sample` / `elicit` as host entries. The existing VM emits its
   generic effect exchange. The decoder binds those names to host-owned effect IDs.
4. `hosting.mts` installs the sample handler through `createEffectCapabilities`, grants
   the declarations, installs checkpoint middleware where available, and uses normal
   hosting: sample executes as an **unsafe** attempt; the move is a participant wait.
5. `provider.mts` adapts `ModelProvider.stream` to a text sample stream. Host code can
   observe provisional events; only terminal text/provenance is returned for journal
   acceptance. The effect handler drains that same stream. No second provider loop.
6. Provider selection is supplied by assembly and pinned with the Scheme program
   identity. Credentials stay outside it. The handler checks returned source against
   that selection. Existing provider API middleware can cap tokens or replace scoped
   providers; no new policy callback or registry is introduced.

The outer journal delivery Outcome contains the domain Outcome, matching
`defineEffect.call` and the existing effect grant. Scheme and typed tools therefore
see the same `ok/value` envelope. This differs deliberately from the earlier compiler
fixture's successful-value-only approval bridge.

## Evidence

`packages/v2/acceptance/__tests__/applications/sandbox-sampling.acceptance.test.ts`
executes both authoring forms on Effect and Effection with a protocol-controlled
provider. It exercises two rounds, actual Scheme checkpoint restoration, native tool
replay, SQLite reopen, invalid replies, invalid model moves, explicit history,
streamed provisional versus accepted output, and existing scoped provider middleware.
It also interrupts an in-flight provider request: cancellation aborts the native read,
but a subsequent run sees the original attempt occupied. Only explicit logical
cancellation stops the workflow; it does not authorize a replacement sample.
Connection loss likewise remains occupied across reopen.

Manual live integration uses the existing Pi adapter and server-only CLI proxy:

```sh
mise exec node@24.22.0 -- node --env-file=apps/yo-chat-v2/.env.local --conditions=development --import tsx experiments/workflow-kernel/sampling/run-live.mjs
```

It creates/removes its own temporary SQLite database. Player replies are explicitly
scripted (`paper`, then `rock`); the two model samples are live. On 2026-11-06, Luna 6
returned `paper` and `rock`, producing `tie;tie;` with exactly two provider requests.
Accepted response IDs:

- `resp_0032c88c84242d6b016aee12bc926487d1be3d123da0db644b`
- `resp_0c80a3b4772774b5016aee12beb6e487d1952b5806e2867dc2`

These IDs are recorded in the workspace handoff; console
output is the live evidence. This was Node integration, not another Cloudflare/browser
recording. The manual runner stays out of ordinary acceptance.

## Limits and next design decision

This is a fixed, reviewed game with host-supplied two-round input, not unrestricted
model-authored program execution or a fair/random game protocol. General authored
loops still need host-owned call/cost budgets before exposing them to arbitrary users.
The binder is a bounded assembly, not a general linker or static termination checker.
Callers must retain the original source/input/model selection for recovery. Unknown
provider outcomes remain unresolved; this slice offers no operator reconciliation UI.
Provider response/accounting richness is intentionally not promoted into this first
text-only contract; provisional events stay host-side.

No ScriptC `ctx.sample` macro, Cloudflare UI integration, Lua/Python binding,
`sampleTools`, `decision`, automatic history, or new kernel instruction
is added. This proves the shared effect contract and ownership first. The next decision
is which request/result data should be shared publicly before expanding compiler
admission or adding higher-level structured/tool sampling.

## Structured sampling slice

`structured.mts` layers `sampleSchemaStream(provider, model, request, schema)` over
`sampleStream`. It adds JSON Schema guidance to the explicit system prompt and maps
only the terminal result through JSON parsing and schema validation. Provisional
events pass through unchanged. This is prompt-guided JSON, **not** provider-native
constrained decoding. A valid JSON `null` is accepted when the selected schema allows it.
The supported schema profile is portable, synchronous Zod schemas with no transforms
or custom refinements; arbitrary executable validators are not a sandbox capability.

The assembly registers `sampleSchema` for a strict `{move, reason}` schema. Typed tools
use `ctx.capabilities.sampleSchema(request)`; Scheme uses `(sampleSchema request)`.
Both use the same effect declaration. The schema is included in the Scheme program
profile and cannot be replaced through request input. This tests registered schemas,
not a general guest-authored JSON Schema API or the final generic TypeScript DX.

The successful effect delivery contains one of:

- `{valid: true, value, sample}` — validated data and original text/provenance.
- `{valid: false, reason, sample}` — completed but invalid output, with `invalid-json`
  or `schema-mismatch`. It is accepted and replayed, never silently retried.

A provider exception still leaves an uncertain delivery occupied. Validation failures
are data rather than exceptions because the model did finish: callers can stop, elicit,
or explicitly request another sample. No repair policy or retry budget is hidden here.
The registered output schema revalidates successful structured values at host delivery.

The second consumer requests a move and explanation, uses the explanation for its
participant wait, and computes the winner after answering. Acceptance covers both
languages and runtimes, SQLite reopen at the wait, invalid JSON, wrong enum values,
unknown properties, null rejection for this object schema, and uncertain delivery.
A stream journey separately verifies legitimate null and provisional events.
No live structured-provider or Cloudflare run is claimed for this slice.

**Design result:** schema projection/validation can be an ordinary stream helper;
registration and grants remain existing effect assembly. General schema discovery,
provider-native schema support, compiler macros and the public generic authoring API
remain open. Schema validity establishes shape, not factual correctness or authority.
