import { z } from "zod";

export class McpHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
export const MCP_MAX_REQUEST_BYTES = 1024 * 1024;
export const requestEnvelope = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().max(512), z.number()]),
  method: z.string().min(1).max(4096),
  params: z.record(z.string(), z.json()),
});

/** Bound streaming bodies as well as requests with a declared Content-Length. */
export async function readMcpBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > MCP_MAX_REQUEST_BYTES)
    throw new McpHttpError(413, -32600, "Request too large");
  if (!request.body) throw new McpHttpError(400, -32700, "Request body is missing");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let raw = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MCP_MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new McpHttpError(413, -32600, "Request too large");
      }
      raw += decoder.decode(next.value, { stream: true });
    }
    raw += decoder.decode();
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof McpHttpError) throw error;
    throw new McpHttpError(400, -32700, "Invalid JSON body");
  } finally {
    reader.releaseLock();
  }
}

export function acceptsMcpResponses(accept: string): boolean {
  const media = new Set(
    accept.split(",").flatMap((part) => {
      const [type, ...parameters] = part.trim().toLowerCase().split(";");
      const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
      return quality && Number(quality.trim().slice(2)) === 0 ? [] : [type.trim()];
    }),
  );
  return media.has("application/json") && media.has("text/event-stream");
}
