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

## Pi composition

`providers-pi-ai` owns the [Responses input counter](../../providers-pi-ai/README.md#responses-preflight-through-pi).
The real pi-ai 1.5.1 transport prepares the payload; the host's existing async
`onPayload` hook applies final output policy, counts model/input/tools, checks the
budget, and returns the admitted payload. Count failure stops inference. No new
Sweatpants hook or generic context-manager primitive is required.

Low-level pi transports require `normalizeContext` in this version so tools and
system instructions enter the transcript. `streamSimple` may clamp output tokens
using an estimate, so a host with an explicit reservation sets it before counting.
The real HTTP/SSE acceptance journey exercises the complete composition under both
runtimes, including exact-fit admission, overflow, count failure and cancellation.

ONI translates its retained Responses history into the provider view, preserving
native reasoning signatures, text phases and call/item IDs. Application-owned image
metadata is omitted only from that view. Pi owns inference encoding and streamed
decoding; ONI retains its raw completed Responses output for journal compatibility.
Summary generation, checkpoint persistence, fresh-run admission and external-effect
reconciliation remain application responsibilities. The separate OpenAI package is
not part of this composition.
