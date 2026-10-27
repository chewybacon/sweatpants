# Evaluator checkpoint capability

CheckpointAdapter is optional capability composition around the shared Guest.
It captures owned suspended Guests and restores a snapshot to a Guest plus its
current Turn. Ordinary acquisition remains GuestWork and does not advance code.

The evaluator owns snapshot decoding, source/runtime compatibility and partial
restore cleanup. The durable host owns accepted history, checkpoint anchoring,
replay policy and the returned Guest's lifetime. There is no second execution
interface or mandatory capture method on Guest.
