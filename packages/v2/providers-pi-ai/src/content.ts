import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ChatContent } from "@sweatpan.ts/providers";

/** Inline images only: URL fetching is a separate host capability, never implicit I/O. */
export function encodeContent(
  content: ChatContent,
  input: readonly string[],
): (TextContent | ImageContent)[] {
  const parts = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
  return parts.map((part) => {
    if (!input.includes(part.type)) {
      throw new Error(`Unsupported pi-ai input modality: ${part.type}`);
    }
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    if (part.type === "image" && part.source.type === "data" && part.metadata === null) {
      const { value, mimeType } = part.source;
      if (
        !mimeType.startsWith("image/") ||
        !value ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
      ) {
        throw new Error("Invalid pi-ai inline image");
      }
      return { type: "image", data: value, mimeType };
    }
    throw new Error(`Unsupported pi-ai content source or metadata: ${part.type}`);
  });
}
