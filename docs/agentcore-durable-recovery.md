# AgentCore durable recovery status

## Implemented recovery boundary

The host authority treats both durable runnable markers and expired activation leases as recoverable work. An activation claim that cleared its runnable marker may therefore be taken over after lease expiry. Warm shutdown stops admission, aborts owned Effection activation scopes, closes their scoped transports through `finally`, and releases ownership without recording user cancellation.

Deployments can run `recoverKnownWorkOnStartup()` once after authority and placement composition is ready. The sweep is bounded, isolates individual activation failures, and leaves failed sessions recoverable. It is intended to make normal restart and deployment recovery reliable.

Process shutdown is not workflow cancellation. The host MUST NOT append cancellation or success merely because SIGTERM, SIGINT, transport loss, or process exit occurred. Already-authorized pull resolution retains its existing capability semantics.

## Deliberately deferred continuous scanner

A continuously polling production recovery service is not included in this delivery. Full notification-loss recovery still needs:

- a long-lived scanner loop over `recoverableSessions()`;
- bounded concurrency and per-placement quotas;
- authority-backed transient placement/authentication backoff;
- pub/sub or local notifications as optional latency hints;
- operator incidents for persistent program/schema absence;
- process supervision and scanner health metrics;
- multi-process Redis certification with actual killed worker processes.

Until that service lands, the implementation is **restart-recoverable, not notification-loss-complete**. Deployments SHOULD run the startup sweep on every host start and MAY trigger the same bounded sweep through an authenticated operator recovery command. This document does not waive REQ-016 or REQ-044; it records their remaining production orchestration work.
