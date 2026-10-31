# Scoped client capabilities

`createResponseSubscriptions` selects an output source through an ordinary Api;
`createElicitationHandler` supplies a typed client handler without importing an
executable tool definition. Both support `.operations`, `.around`, and `.install`.
These are generic capability contracts, not a complete client session or wire protocol.

Subscriptions retain their acquisition source and scope. Middleware can wrap `next`
for frame observation. Cursor format and source identity belong to the application;
buffer offsets are instance-local, not a persistent log. Disconnecting one reader
must not terminate independently owned production.

Reply caching, reconnect logic, server answer validation and durable deduplication
remain outside the handler facade. Canceling a pending handler releases its own UI
work; an in-memory reply cache does not establish durable exactly-once behavior.
