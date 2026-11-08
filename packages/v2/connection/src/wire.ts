import type { WireCodec } from "./contracts.ts";
import type { Frame } from "./types.ts";

export function decode(codec: WireCodec, bytes: unknown): Frame {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("Expected connection wire bytes");
  }
  const value = codec.decode(bytes);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid connection frame");
  }
  const frame = value as Record<string, unknown>;
  if (!Number.isSafeInteger(frame.id) || (frame.id as number) < 0 || !("value" in frame)) {
    throw new Error("Invalid connection correlation");
  }
  if (frame.kind !== "request" && frame.kind !== "response") {
    throw new Error("Invalid connection frame kind");
  }
  if (
    frame.kind === "response" &&
    (typeof frame.ok !== "boolean" || (!frame.ok && typeof frame.value !== "string"))
  ) {
    throw new Error("Invalid connection response");
  }
  return frame as unknown as Frame;
}
