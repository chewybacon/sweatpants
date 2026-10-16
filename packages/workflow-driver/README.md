# @sweatpants/workflow-driver

Optional ProgramDriver adapter over workflow-kernel. No SDK, journal, or application
package imports it. Importing it does not register drivers or load Wasm.

The first integration supports typed elicitation boundaries only. The caller supplies
an artifact loader, a kernel factory, and bindElicit to validate and bind the kernel's
request to an installed elicitation contract. Other command/effect families fail
explicitly. This is a spike, not a general replacement for existing tool drivers.

- attach prepares the pinned program and kernel in the caller's Effection scope.
- step advances start, accepted replies, and logical cancellation.
- checkpoint captures portable kernel state and the current frontier, bound to
  program, input, task, and session identity. Unrecorded cancellation falls back
  to a replay marker rather than publishing unaccepted execution state.
- restore either uses shared full replay or restores a compatible continuation
  and verifies/replays the accepted suffix.
- shutdown releases compute without logical cancellation. Scope exit also closes
  the kernel; kernel close/dispose must be idempotent.

The loader must verify artifact content hashes. The authority must independently
verify checkpoint provenance and bind resumeAfter before calling restore. Matching
hashes inside the driver are consistency checks, not authorization. The current
host now publishes captures at its atomic frontier bind, persists them through
the authority snapshot, and supplies only the accepted suffix on recovery.

The JS reference adapter and executable proofs live in
experiments/workflow-kernel/artifact-build/reference-kernel.mjs,
kernel-driver-test.mjs, and kernel-authority-test.mjs. They exercise the real
explicit-state evaluator. No Hoot continuation implementation is implied.
