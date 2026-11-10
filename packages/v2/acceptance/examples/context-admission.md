# Context admission at the adapter boundary

ONI adds host feedback and tools, projects history once, archives oversized tool
text before publishing retrieval references, and passes the complete canonical
request through `createPiAiProvider`. Without an archive owner it keeps text inline.

The framework preserves provider usage on assistant messages with a fingerprint of
the model, tools and normalized native transcript. Pi receives applicable usage on unchanged
history; projection, compaction or changed tools cause local estimation instead.
JSON persistence retains this metadata. The fingerprint is an estimate validity
check, not journal authority. See [the adapter](../../providers-pi-ai/README.md#local-context-admission-through-pi).

ONI restores native history through the adapter's synchronous `prepareContext`.
The adapter then normalizes and validates usage. ONI calls pi's
`estimateContextTokens` on that same transcript, adds
`max(4096, ceil(tokens * 0.15))` safety tokens and reserves its configured output
through `measureContextBudget`. Provenance remains `estimated`. This requires no
counting endpoint or separate network request. Pi's image allowance and text
heuristic are approximate; provider context-limit rejection remains a supported
checkpoint/compaction trigger.

The existing pi `onPayload` hook applies the independent byte guard and final output
reservation before inference. Exact serialized bodies are retained for retries.
The adapter normalizes the transcript to retain schemas and system instructions.
Native history changes must occur in `prepareContext`, before the usage check.

Framework acceptance uses real pi Responses HTTP/SSE peers under both runtimes for
persistence, invalidation and local admission. ONI also verifies late feedback,
retained reasoning, media, retrievable originals, archive failure, exact retries,
cancellation and provider rejection. No live accounting or crash recovery is claimed.
Summary generation, checkpoint persistence and external-effect reconciliation stay
application responsibilities; no new context-manager primitive is introduced.
