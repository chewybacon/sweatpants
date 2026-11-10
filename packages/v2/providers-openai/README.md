# Responses input counting

`createResponsesInputCounter({ endpoint, headers })` supplies the narrow HTTP
adapter required by ONI's prepared Responses request. Construction performs no IO.
`count({ model, input, tools }, signal)` calls `POST /responses/input_tokens` once
and returns `{ tokens, kind: "measured" }` from a validated provider response.

This supports explicit-history requests with text, media and retained Responses
items already encoded in `input`. The host must supply every input-bearing field;
this initial subset rejects extra fields rather than silently ignoring instructions,
conversation state or previous-response IDs. It is not a complete Responses inference
adapter or tokenizer. Model limits, output reservations and credentials remain with
the host. Unsupported gateway endpoints and invalid counts fail; there is no estimate
fallback, inference dispatch, automatic retry or billable-usage aggregation.

ONI serializes inference once, supplies the matching model/input/tools to the counter,
uses `measureContextBudget` with configured model limits, and sends its reserved
output value as `max_output_tokens`. Only a fitting request reaches inference; its
retries reuse the original serialized body without recounting. Count success is an
observation, not provider dispatch or durable response acceptance. Aliases, gateways
and remotely referenced content can change; measured fit is not a guarantee that a
later inference request cannot be rejected.

The adapter uses native fetch and an explicit caller-owned AbortSignal. A runtime
host may call it through `runtime.fromPromise(signal => counter.count(input, signal))`.
The caller owns timeout and cancellation; no ambient runtime, scope, endpoint or
credentials are selected. Headers are captured at construction, input is serialized
before awaiting, and error bodies are not included in HTTP-status errors.

Acceptance exercises a local HTTP peer: exact encoded fields, budget arithmetic,
malformed and unsupported responses, pre-abort and in-flight cancellation. ONI's
consumer journey separately verifies counting, inference gating, output reservations,
artifact recovery and retry bodies. This is not a live-provider or process-crash test.

Protocol source: [OpenAI input-token counting reference](https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count).
