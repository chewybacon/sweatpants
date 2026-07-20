# ADR-003: One Pre-Stable Model Sampling Contract

**Status:** Accepted

## Context

Before the first stable release, Sweatpants accumulated multiple incompatible `model.sample` definitions. The same symbolic version was also used with different schemas. Because no stable program releases have been published, preserving these accidental contracts would add migration machinery without user value.

A temporary consolidation duplicated authored messages and provenance inside `modelPreferences`, misusing a provider-facing field and requiring heuristic decoding.

## Decision

Before stable publication, all first-party roots, tools, foreign compatibility children, and authored sub-agents use the single exported `MODEL_SAMPLE_EFFECT` object and whole-contract digest.

There is no historical `model.sample@1`/`@2` compatibility path in the pre-stable codebase.

The canonical request carries each concern once:

- canonical messages;
- canonical system prompt content;
- model tools and response constraints;
- provider preferences only in `modelPreferences`;
- data classifications in `classifications`;
- sampling policy in `sampling`.

Authored provenance MUST NOT be duplicated into `modelPreferences`. Generic model handlers MUST NOT need generation-detection heuristics. Runtime adapters MAY deterministically project canonical authored messages into provider-specific message types.

After the first stable release, changing any normative field requires a new effect version. Whole-contract digest drift under the same stable name and version MUST fail binding and dispatch.

## Consequences

- Child and sub-agent sampling resolves through the same Host handler and live projection path.
- Provider policy remains distinct from data classification and authored provenance.
- Pre-stable pinned digest vectors intentionally change with the canonical contract.
- There is no promise to replay development-only journals created under discarded sampling shapes.

## Enforcement

- Root, foreign adapter, and authored chat exports reference the same `MODEL_SAMPLE_EFFECT` object.
- Whole-contract tests reject same-name/version schema or cancellation drift.
- Source tests prohibit the removed authored sample descriptor exports and the `sweatpants.authored-model-bridge.v1` marker.
