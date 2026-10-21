import { assertJson, type Json } from "@sweatpants/foundation";

// The authority limits inline results to 1 MiB; the VM allows 4 MiB snapshots.
// Compression keeps large candidate heaps within the journal's existing bound.
export async function encodeLuaCheckpoint(state: Record<string, Json>): Promise<string> {
  const compressed = new Blob([JSON.stringify(state)])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(compressed).arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  const encoded = btoa(binary);
  if (encoded.length > 1_000_000) {
    throw new Error("Lua checkpoint exceeds journal byte budget");
  }
  return encoded;
}

export async function decodeLuaCheckpoint(encoded: string): Promise<Record<string, Json>> {
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  const reader = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const chunks: ArrayBuffer[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      length += next.value.length;
      if (length > 4 * 1024 * 1024) {
        throw new Error("Lua checkpoint exceeds VM byte budget");
      }
      chunks.push(Uint8Array.from(next.value).buffer);
    }
  } finally {
    await reader.cancel();
  }
  const value = assertJson(JSON.parse(await new Blob(chunks).text()));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Lua checkpoint");
  }
  return value;
}
