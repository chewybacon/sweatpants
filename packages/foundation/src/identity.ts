import { v4, v7 } from "uuid";

/** Mint at an authority boundary, then persist and reuse on retries and replay. */
export function uuidv7(): string {
  return v7();
}

/** Generate a UUIDv4 using secure random bytes, including on HTTP development origins. */
export function uuidv4(): string {
  return v4();
}
