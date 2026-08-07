import { describe, expect, it } from "vitest";
import {
  ChatContentDecodeError,
  DEFAULT_CHAT_CONTENT_LIMITS,
  decodeChatContent,
} from "./content.ts";

const imageData = {
  type: "image" as const,
  source: { type: "data" as const, value: "aGVsbG8=", mimeType: "image/png" },
};

function expectDecodeError(
  value: unknown,
  code: ChatContentDecodeError["code"],
  options?: Parameters<typeof decodeChatContent>[1],
): ChatContentDecodeError {
  try {
    decodeChatContent(value, options);
  } catch (error) {
    expect(error).toBeInstanceOf(ChatContentDecodeError);
    const decoded = error as ChatContentDecodeError;
    expect(decoded.code).toBe(code);
    return decoded;
  }
  throw new Error(`expected ${code}`);
}

describe("decodeChatContent", () => {
  it("accepts strings and preserves ordered multimodal parts", () => {
    expect(decodeChatContent("hello")).toBe("hello");

    const value = decodeChatContent([
      { type: "text", text: "before" },
      imageData,
      { type: "text", text: "after" },
    ]);

    expect(value).toEqual([
      { type: "text", text: "before" },
      { ...imageData, metadata: null },
      { type: "text", text: "after" },
    ]);
    expect(Object.isFrozen(value)).toBe(true);
  });

  it("accepts all supported media source forms", () => {
    expect(
      decodeChatContent([
        { type: "image", source: { type: "url", value: "https://example.test/a.png" } },
        { type: "audio", source: { type: "data", value: "aGk=", mimeType: "audio/wav" } },
        { type: "video", source: { type: "url", value: "http://example.test/v.mp4" } },
        {
          type: "document",
          source: { type: "url", value: "https://example.test/a.pdf", mimeType: "application/pdf" },
          metadata: { page: 1 },
        },
      ]),
    ).toEqual([
      {
        type: "image",
        source: { type: "url", value: "https://example.test/a.png" },
        metadata: null,
      },
      {
        type: "audio",
        source: { type: "data", value: "aGk=", mimeType: "audio/wav" },
        metadata: null,
      },
      {
        type: "video",
        source: { type: "url", value: "http://example.test/v.mp4" },
        metadata: null,
      },
      {
        type: "document",
        source: { type: "url", value: "https://example.test/a.pdf", mimeType: "application/pdf" },
        metadata: { page: 1 },
      },
    ]);
  });

  it("rejects unknown fields and discriminators", () => {
    expectDecodeError([{ type: "text", text: "ok", id: "unexpected" }], "unknown-field");
    expectDecodeError([{ type: "spreadsheet", text: "nope" }], "invalid-discriminator");
    expectDecodeError([{ type: "image", source: { type: "other", value: "x" } }], "invalid-source");
  });

  it("rejects invalid sources and modality MIME hints", () => {
    expectDecodeError(
      [{ type: "image", source: { type: "data", value: "not base64", mimeType: "image/png" } }],
      "invalid-base64",
    );
    expectDecodeError(
      [{ type: "image", source: { type: "data", value: "aGk=", mimeType: "audio/wav" } }],
      "modality-mismatch",
    );
    expectDecodeError(
      [{ type: "image", source: { type: "url", value: "/relative/image.png" } }],
      "invalid-url",
    );
    expectDecodeError(
      [{ type: "image", source: { type: "url", value: "file:///tmp/image.png" } }],
      "invalid-url",
    );
    expectDecodeError(
      [
        {
          type: "image",
          source: { type: "url", value: "https://example.test/image", mimeType: "bad" },
        },
      ],
      "invalid-mime-type",
    );
  });

  it("rejects non-object metadata and preserves JSON metadata", () => {
    expect(decodeChatContent([{ ...imageData, metadata: { labels: ["a", "b"] } }])).toEqual([
      { ...imageData, metadata: { labels: ["a", "b"] } },
    ]);
    expectDecodeError([{ ...imageData, metadata: "not an object" }], "invalid-value");
  });

  it("enforces default and stricter configured limits", () => {
    const exactParts = Array.from({ length: DEFAULT_CHAT_CONTENT_LIMITS.maxParts }, (_, index) => ({
      type: "text" as const,
      text: String(index),
    }));
    expect(decodeChatContent(exactParts)).toHaveLength(DEFAULT_CHAT_CONTENT_LIMITS.maxParts);

    const tooManyParts = [...exactParts, { type: "text" as const, text: "over" }];
    const partError = expectDecodeError(tooManyParts, "limit-exceeded");
    expect(partError.limit).toMatchObject({ name: "maxParts", actual: 65, maximum: 64 });

    const strictError = expectDecodeError([{ type: "text", text: "12345" }], "limit-exceeded", {
      limits: { maxTextBytes: 4 },
    });
    expect(strictError.limit).toMatchObject({ name: "maxTextBytes", actual: 5, maximum: 4 });
    expect(() =>
      decodeChatContent("ok", {
        limits: { maxContentBytes: DEFAULT_CHAT_CONTENT_LIMITS.maxContentBytes + 1 },
      }),
    ).toThrow(/invalid-limits/);
  });

  it("rejects metadata and content depth over the configured maximum", () => {
    let nested: Record<string, unknown> = {};
    for (let index = 0; index < 33; index += 1) {
      nested = { child: nested };
    }
    expectDecodeError([{ ...imageData, metadata: nested }], "limit-exceeded");
  });

  it("does not fetch URL sources or rewrite omitted MIME types", () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("decodeChatContent must not fetch URLs");
    }) as typeof fetch;
    try {
      expect(
        decodeChatContent([
          { type: "image", source: { type: "url", value: "https://example.test/a" } },
        ]),
      ).toEqual([
        {
          type: "image",
          source: { type: "url", value: "https://example.test/a" },
          metadata: null,
        },
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
