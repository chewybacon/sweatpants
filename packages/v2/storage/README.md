# Storage contracts

`Serializer` is a synchronous, trusted byte representation: `format`, `encode` and
`decode`. It does not validate a domain schema, declare a recursive JSON type, or
claim that `decode<T>` can establish T. Concrete journal types belong to the typed
storage binding; a heterogeneous decoded payload crosses that trust boundary once.

Use the existing Composition context and API to select a serializer. Resolve it
before beginning a native transaction, then call its synchronous methods inside
that transaction. Middleware may replace the selection, observe bytes or return
wrapped methods. No separate serialization helper family is required.

Representation-changing layers must use a distinct format identity. Observational
wrappers preserve it. A future reader must explicitly support the recorded format;
scope inheritance does not make different representations interchangeable.

The first hosted acceptance tracer uses a serialized delivery boundary with the
memory journal. It proves scoped selection/restoration, middleware wrapping, native
structured values, one encode/decode per delivery, encoding failure before acceptance,
and authority fencing after suspended resolution. It does not prove a database
transaction implementation. Storage should encode changed payloads once and decode
selected rows once, without reserializing a write acknowledgement or repeatedly
validating decoded domain data.
