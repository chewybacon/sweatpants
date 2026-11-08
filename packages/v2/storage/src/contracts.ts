/**
 * Trusted synchronous representation of stored values. Methods must not suspend or
 * perform external effects. Encoding may reject unsupported values; decoding does
 * not validate a domain schema or prove a caller-selected TypeScript type.
 *
 * Resolve the implementation before entering a native transaction. Representation
 * changes (including compression/encryption) require a distinct format identity.
 */
export interface Serializer {
  /** Identity of the complete representation, including its compatibility version. */
  readonly format: string;
  /** Encode once at the storage boundary; failure must leave writes uncommitted. */
  encode(value: unknown): Uint8Array;
  /** Decode trusted stored bytes once; consumers retain their concrete domain types. */
  decode(bytes: Uint8Array): unknown;
}
