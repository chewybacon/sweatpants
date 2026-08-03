# React Chat Acceptance Boundary

React acceptance mounts the real `@sweatpants/chat-client` through the thin
`useChat({ client })` external-store adapter. Semantic behavior is driven by
Test Rig commands and deterministic model/tool simulators; AG-UI is observed
passively.

The adapter owns only React-native scheduling, prepared render parts, and the
React plugin facade. Chat transport, message folding, reconnect, pipeline
lifetime, and host settlement remain in `@sweatpants/chat-client`.

Application renderers consume one recursive `messages[].parts` tree. No
streaming sidecar, host-tree helper, callback registry, or React-owned session
is part of the public contract.
