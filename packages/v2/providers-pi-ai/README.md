# Pi-ai provider adapter

`createPiAiProvider(runtime, options)` translates canonical v2 model requests into
pi-ai's SDK context and translates validated SDK events/results back into v2 data.
The host supplies a resolved SDK model and its registry's `streamSimple` function:

```ts
const provider = createPiAiProvider(runtime, {
  model,
  stream: (model, context, options) => models.streamSimple(model, context, options),
});
const api = runtime.composition.createApi("model", { operations: provider });
const subscription = yield * api.operations.stream(request);
```

Selection, registry/authentication setup and credentials belong to host assembly.
The adapter captures a detached model configuration; each subscription creates a
fresh request. It supports text and inline base64 images in user/tool inputs, reasoning signatures, tool declarations and fully
settled tool-call/result history. Leading system/developer instructions combine into
the SDK system prompt, as in v1. Instructions after conversation content are rejected.
Duplicate call IDs, unmatched results and unfinished tool groups reject before dispatch.
SDK bookkeeping timestamps and prior usage are synthetic; canonical messages do not
claim historical SDK telemetry.

The chat adapter uses `streamSimple`: auto/none tool choice, temperature, output-token
limits, reasoning levels (including `max`), and per-level thinking budgets are forwarded.
Unsupported model reasoning levels, invalid budgets and output limits reject before
SDK dispatch. Required tool choice, topP/topK and responseFormat still reject: the
SDK simple driver does not implement these uniformly. Images require an image-capable
model, inline base64 data and null metadata. URL fetching is not implicit. Audio,
video, documents and assistant-image history remain unsupported by this SDK path.

`describePiAiModel(model)` returns a frozen, credential-free model projection for UI
and context planning. It includes input/output modalities, context/output limits and
reasoning levels accepted by the SDK model configuration. Missing level-map entries
use SDK defaults; this is not a live provider capability probe. Keep this data separate
from the operation-only provider when installing it into a scoped API.

`createPiAiImageProvider(runtime, { model, generate, apiKey? })` binds a separate SDK
image model. Supply `generate: (model, context, options) =>
models.generateImages(model, context, options)`. Its `generate({ input })` operation
accepts text and inline source images and returns validated text/image output,
provenance and usage (null when absent). Cancellation aborts the pending SDK Promise.
This does not provide a live image-preview stream. Provider-specific size/style
controls are not claimed: the installed image driver ignores generic metadata.

Both adapters explicitly disable SDK automatic retries; retry policy belongs to
hosting. The host still owns registry/authentication setup and model selection.
Voice/speech/transcription are deferred by agreement; the installed SDK has no speech
API. Canonical audio content does not imply a functioning voice adapter.

Scope exit aborts the request and awaits the SDK iterator's return when available.
Interrupting an individual pending read aborts and poisons that subscription even
if its owner remains alive. Concurrent reads reject; failed/uncertain inference is
never retried by the adapter. The supplied SDK driver must honor abort and release
pending reads; this adapter invents no network timeout or independent process-kill
barrier. Iterator cleanup is not proof that a remote provider stopped billing.

SDK values cross a validation boundary: invalid events, content indices/kinds,
non-finite accounting, duplicate final call IDs, error/aborted/deferred terminal
results and inconsistent done reasons fail delivery. Provider error events become
exceptions; provider diagnostic text is not included in those generic errors.
Completed responses retain canonical usage/provenance and reasoning/tool signatures.
Reasoning token counts are subsets of output; one-hour cache writes are subsets of
cacheWrite. They are preserved without adding them to total again. Reported reasoning
effort is retained separately from the request, with null for unreported fields.
Current validation is structural, not v1's complete payload-size/modality policy.

Acceptance uses a scripted SDK peer through the public adapter. It verifies request
translation, event/result conversion, continuation with tool results, scoped disposal,
read interruption, malformed events/results and pre-dispatch rejection on both
runtimes. It does not make live calls, validate a vendor HTTP protocol, or establish
OS-process durability. Chat journal/reconnect evidence remains in the separate
canonical-provider tracer.

Media acceptance additionally exercises image input, generation, cancellation and
failed results, model projections, reasoning budgets and per-request context budgets
on both runtimes. These are scripted SDK-boundary tests, not live model capability
or media-decoding tests.
