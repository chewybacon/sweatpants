# Content-addressed resources and program identity

## Resource packages

`@sweatpants/agent-sdk` exposes `defineResourcePackage`, `textResource`, `jsonResource`, and `binaryResource` for immutable static content. A package manifest is portable metadata; local content bindings retain copied bytes and return copies on every read.

Resource packages grant no authority. Mounts must explicitly select one scope:

- `program_private` for the owning durable program;
- `model_readable` with `public`, `internal`, `confidential`, or `restricted` classification;
- `tool_scoped` with exact program ID, version, and digest allowlists.

Scripts are inert bytes. A filename, shebang, executable source mode, or media type never installs process, filesystem, network, credential, or execution capability.

`resourcesFromDirectory` and `compileResourceDirectory` are build-time tools. Production and replay code use generated bindings and never fall back to the source directory. Write mode updates deterministic generated source; verify mode reports `stale_generated_resource_package` when source or compiler configuration changes.

## Guidance is advisory

`defineGuidance` associates a bounded ID and summary with one exact text entry in a resource package. `guidanceIndex` exposes only ID, summary, and digest-qualified entry URI. Guidance text is advisory model context: it is not an authorization grant, enforced policy, executable SOP, or durable workflow. Enforcement requires a separate durable program or policy mechanism.

Generated `resources.stat`, `resources.list`, `resources.read`, and `resources.search` programs are deterministic native children. They declare no effects, require no handler credentials, and carry concrete closed input/output schema catalogs. Their identities cover the reader engine, operation, exact resource view, consumer scope, schemas, and output bounds. The abbreviated digest fragments in a reader `programId` are presentation-only; durable lookup always uses the full `id@version#digest` tuple.

Search is normalized with trimmed NFC text and locale-independent case comparison. V1 returns the first match per authorized text file in lexicographic logical-path order. It scans only through the exact `resources.read` projection, enforcing file digest/size checks, `maxReadBytes`, an aggregate scan budget of `maxReadBytes * maxSearchMatches`, bounded excerpts, and `maxSearchMatches`. Program-private and unrelated tool-scoped files do not affect results or counts.

Internal deterministic readers retain distinct `resource_access_denied` and `resource_not_found` evidence. External adapters can opt into hidden lookup mode, which collapses denied, missing, and identity-mismatched lookups to the same content-safe `resource_not_found` response.

## Generated durable-program identity

New release artifacts should use `generateProgramArtifactIdentity` and `createGeneratedPinnedDurableProgram`. Identity covers the durable manifest without its digest, an explicit reproducible implementation artifact digest, pinned resource package digests, and generator version. `generateProgramIdentityModule` supports deterministic write and verify modes.

Existing hand-pinned programs remain supported with `asserted` provenance. `validateProgramBindingsForRelease(..., { releaseStrict: true })` rejects asserted pins with `asserted_program_identity_forbidden`. Generated provenance is evidence of declared digest derivation, not an authority grant.

An outer agent or deployment identity is only as trustworthy as every transitive program pin it contains. Migration from an asserted pin to a generated digest creates a new program identity and does not rewrite existing journal history.

The canonical low-level Durable Execution constructor is `createPinnedDurableProgram`. The staged product builder `createDurableTool("name")` from `@sweatpants/agent-sdk` is unchanged.
