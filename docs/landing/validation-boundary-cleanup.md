# Validation Boundary Cleanup — Landing Evidence

## Status

Retired. This was migration evidence for the validation-boundary repackaging; the temporary inventory
and scanner were removed after the owning parsers and permanent package tests landed.

## Final evidence

- Historical inventory and scanner: retired after migration completion
- Permanent tooling tests: `pnpm test:tooling`
- Typecheck: `pnpm check`
- Formatting: `pnpm format:check`
- Package exports: `pnpm validate:exports`
- Product surface: `pnpm validate:product-surface`
- Module graph: `pnpm validate:module-graph`
- Deterministic landing: `pnpm land`
- Landing summary: `.artifacts/landing/2026-07-30T00-27-44-774Z-deterministic/summary.json`

The referenced deterministic landing completed all 19 configured stages before
review follow-up changes. Its artifact is retained as baseline evidence but is
superseded until a new clean-tree `pnpm land` run is recorded here.

## Residue policy

During migration, the production declaration scanner reported only `validateStandardSchema` and
Standard Schema V1 `~standard.validate` callbacks. The inventory served as a temporary deletion ledger;
it is not a permanent source-coordinate gate. No forwarding validator aliases were retained.

## Runtime policy implemented

- Framework-owned structural values parse at their owning ingress with strict,
  package-local Zod schemas.
- User-authored and replaceable adapter schema slots use Standard Schema V1.
- Runtime validator objects stay process-local; portable descriptors and exact
  digest selection are used for durable restore.
- Input validation precedes user-code invocation and output validation precedes
  acceptance/publication.
- Semantic identity, digest, replay, authorization, origin, DNS, and fence
  checks remain explicit typed verification.
- Boundary errors use owning error families and bounded validation issue
  projections; raw validator exceptions and rejected values are not attached to
  public tool-parameter errors.
