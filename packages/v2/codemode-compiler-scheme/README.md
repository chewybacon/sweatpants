# Scheme workflow target

`schemeWorkflowTarget.emit(module)` consumes the shared workflow S-expression IR
and returns a `SchemeWorkflowArtifact` containing executable source and effect
metadata. The Scheme kernel already implements this dialect, so this target only
checks the supported profile/entry syntax and adds the entry invocation.

It depends on `codemode-compiler`, not any frontend, ScriptC, or a VM. Pass its
source to the separately acquired Scheme kernel. Runtime identity, checkpoint
compatibility and the schema/handler resolver remain assembly-owned.

This is a target for trusted, frontend-verified modules. It does not parse and
revalidate arbitrary Scheme, resolve host imports, or establish invocation authority.
The existing acceptance journey feeds it a JSON-round-tripped module, then proves
capture, cleanup and pending-completion behavior through fresh-machine restore.
