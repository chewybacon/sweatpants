# Workflow kernel research

Versioned continuation/compiler spike imported from the sibling
scheme-checkpoint-spike directory. This is experimental code, not a workspace
package or production driver. Continue this work here.

The current executable reference is artifact-build/README.md. Source and tests
are retained; generated checkpoint/result JSON is recreated by those tests.
Earlier Steel/Gambit/Hoot exploration and local build caches are not imported.

Tests use the workspace dependencies and built SDK/runtime packages.
Run from the repository root with Node 22:

    node experiments/workflow-kernel/artifact-build/authority-test.mjs
    node experiments/workflow-kernel/artifact-build/driver-test.mjs
    node experiments/workflow-kernel/artifact-build/pull-test.mjs
    node experiments/workflow-kernel/artifact-build/test.mjs

The focus is a replaceable evaluator behind ProgramDriver, explicit continuation
state, and authority-verified recovery. Production registration, full driver
coverage, Wasm implementation and deadlines remain separate work.
