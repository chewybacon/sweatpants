# @sweatpants/durable-conversations

Spike package for one durable stream per conversation.

This package prototypes:

- `PUT /conversations/{id}` to create a conversation stream
- `POST /conversations/{id}` to append messages and continue flow
- `GET /conversations/{id}?offset=X` to replay from an offset

The spike includes a simple `echo` tool path with an explicit user elicitation round-trip.
