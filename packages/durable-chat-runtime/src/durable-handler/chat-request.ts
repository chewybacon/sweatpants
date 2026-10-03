import { CrankError } from "@sweatpants/durable-execution";
import { call, type Operation } from "effection";
import { parseChatRequestBody } from "./request-normalization.ts";
import type { ChatRequestBody } from "./types.ts";

const MAX_CHAT_REQUEST_BYTES = 2 * 1024 * 1024;
function* readBoundedChatRequest(request: Request): Operation<unknown> {
  if (!request.body) {
    return {};
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = yield* call(() => reader.read());
      if (result.done) {
        break;
      }
      total += result.value.byteLength;
      if (total > MAX_CHAT_REQUEST_BYTES) {
        yield* call(() => reader.cancel());
        throw new CrankError("payload_too_large", "Chat request body exceeds the 2 MiB limit");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new CrankError("invalid_chat_request", "Chat request body must be valid JSON");
  }
}

export interface PreparedChatRequest {
  request: Request;
  body: ChatRequestBody;
  conversationId: string;
}

export function* readChatBody(request: Request): Operation<ChatRequestBody> {
  return request.body
    ? parseChatRequestBody(yield* readBoundedChatRequest(request))
    : { messages: [] };
}
