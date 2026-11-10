# Context admission at the adapter boundary

The ONI consumer exposed an ordering error: its host checked pressure before adding
budget/progress feedback, using previous-response input usage; its Responses adapter
then separately projected history. A canonical request estimate could not establish
the size of the adapter's final request, which also retains opaque provider output.

The consumer now owns this sequence:

1. Add all host feedback and tools before calling the adapter.
2. Project history once, persisting original tool text before publishing retrieval
   references. Without an archive owner, retain the text inline.
3. Encode and serialize the actual Responses payload once.
4. Apply a byte-size policy, then count its model/input/tools through the provider
   and include the explicit output reservation in the token budget. Record size, hash
   and count provenance without disclosing text or media.
5. Send the same body on every inference attempt. A preflight refusal or provider
   context-limit rejection returns control to the existing checkpoint/compaction flow.

The consumer acceptance journey uses its real adapter and a local HTTP Responses
peer. It checks exact retry bodies, tool schemas, late host feedback, retained
reasoning, image payloads, retrievable originals, archive failure, unchanged source
history, checkpoint contents and separation from previous-response usage. This is
local protocol evidence, not live-provider accounting or crash recovery.

## Promoted boundary

The consumer subsequently added real provider input counting. The supported boundary
is now the [Responses input counter](../../providers-openai/README.md), a protocol
adapter for explicit model/input/tools. ONI owns inference encoding and supplies the
matching fields, chooses model limits and an output reservation, uses existing
`measureContextBudget`, then gates inference. An unavailable count stops dispatch;
wire-byte size remains an independent guard.

The original generic admission helper remains removed. No new context-manager
primitive is needed: the missing capability was a provider-specific count, with
explicit cancellation and no implicit fallback or retry. Summary generation,
checkpoint persistence, fresh-run admission and external-effect reconciliation remain
application responsibilities. This integration does not establish summary accuracy,
crash recovery or live-gateway compatibility.
