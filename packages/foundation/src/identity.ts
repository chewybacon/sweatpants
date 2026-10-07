import { v7 } from "uuid";

/** Mint at an authority boundary, then persist and reuse on retries and replay. */
export function uuidv7(): string {
  return v7();
}
