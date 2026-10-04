import { describe, it, expect } from "vitest";
import {
  acceptsMcpResponses,
  readMcpBody,
  MCP_MAX_REQUEST_BYTES,
  requestEnvelope,
} from "../http.ts";

describe("MCP HTTP request boundary", () => {
  it("rejects an oversized declared body before reading", async () => {
    await expect(
      readMcpBody(
        new Request("http://localhost", {
          method: "POST",
          body: "{}",
          headers: { "content-length": String(MCP_MAX_REQUEST_BYTES + 1) },
        }),
      ),
    ).rejects.toMatchObject({ status: 413 });
  });
  it("bounds an undeclared streaming body and cancels the reader", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(65536));
      },
      cancel() {
        cancelled = true;
      },
    });
    const init: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half" };
    await expect(readMcpBody(new Request("http://localhost", init))).rejects.toMatchObject({
      status: 413,
    });
    expect(cancelled).toBe(true);
  });
  it.each(["{", "", "undefined"])("rejects malformed JSON %j", async (body) => {
    await expect(
      readMcpBody(new Request("http://localhost", { method: "POST", body })),
    ).rejects.toMatchObject({ status: 400, code: -32700 });
  });
  it.each([
    [],
    { jsonrpc: "2.0", id: 1, result: {} },
    { jsonrpc: "2.0", id: null, method: "tools/list", params: {} },
    { jsonrpc: "1.0", id: 1, method: "tools/list", params: {} },
  ])("rejects non-request envelopes", (value) => {
    expect(requestEnvelope.safeParse(value).success).toBe(false);
  });
  it("does not treat substrings or zero quality as supported media types", () => {
    expect(acceptsMcpResponses("application/json-invalid, text/event-stream")).toBe(false);
    expect(acceptsMcpResponses("application/json;q=0, text/event-stream")).toBe(false);
    expect(acceptsMcpResponses("application/json; charset=utf-8, text/event-stream;q=0.8")).toBe(
      true,
    );
  });
});
