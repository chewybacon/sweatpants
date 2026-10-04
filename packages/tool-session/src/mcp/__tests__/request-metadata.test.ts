import { compileMcpParameterHeaders, validateMcpParameterHeaders } from "../request-metadata.ts";
import { describe, expect, it } from "vitest";
import {
  encodeMcpHeaderValue,
  readMcpRequestMetadata,
  requireMcpFormCapability,
} from "../request-metadata.ts";

const version = "2026-07-28";
function request(name = "pick_card") {
  return {
    protocolVersion: version,
    method: "tools/call",
    headers: new Headers({
      "MCP-Protocol-Version": version,
      "Mcp-Method": "tools/call",
      "Mcp-Name": encodeMcpHeaderValue(name),
    }),
    params: {
      name,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
      },
    },
  };
}

describe("MCP per-request metadata", () => {
  it("does not require an initialization handshake or client identity hint", () => {
    expect(readMcpRequestMetadata(request())).toEqual({
      protocolVersion: version,
      clientInfo: undefined,
      capabilities: { elicitation: { form: {} } },
    });
  });
  it("does not inherit capabilities across requests", () => {
    requireMcpFormCapability(readMcpRequestMetadata(request()).capabilities);
    const next = request();
    const parsed = readMcpRequestMetadata({
      ...next,
      params: {
        ...next.params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": version,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    expect(() => requireMcpFormCapability(parsed.capabilities)).toThrow("form elicitation");
  });
  it.each(["MCP-Protocol-Version", "Mcp-Method", "Mcp-Name"])(
    "rejects a missing %s header",
    (header) => {
      const input = request();
      input.headers.delete(header);
      expect(() => readMcpRequestMetadata(input)).toThrow(
        expect.objectContaining({ code: -32020, status: 400 }),
      );
    },
  );
  it.each(["MCP-Protocol-Version", "Mcp-Method", "Mcp-Name"])(
    "rejects a mismatched %s header",
    (header) => {
      const input = request();
      input.headers.set(header, "wrong");
      expect(() => readMcpRequestMetadata(input)).toThrow(
        expect.objectContaining({ code: -32020 }),
      );
    },
  );
  it("rejects legacy versions rather than negotiating a compatibility session", () => {
    const input = request();
    input.headers.set("MCP-Protocol-Version", "2025-11-25");
    input.params._meta["io.modelcontextprotocol/protocolVersion"] = "2025-11-25";
    expect(() => readMcpRequestMetadata(input)).toThrow(
      expect.objectContaining({
        code: -32022,
        data: { requested: "2025-11-25", supported: [version] },
      }),
    );
  });
  it.each([
    undefined,
    {},
    { "io.modelcontextprotocol/protocolVersion": version },
    {
      "io.modelcontextprotocol/protocolVersion": version,
      "io.modelcontextprotocol/clientCapabilities": null,
    },
  ])("rejects missing required metadata %#", (meta) => {
    const input = request();
    expect(() =>
      readMcpRequestMetadata({ ...input, params: { name: "pick_card", _meta: meta } }),
    ).toThrow(expect.objectContaining({ code: -32600 }));
  });
  it.each(["選択", " padded ", "line\nbreak", "=?base64?literal?="])(
    "round trips encoded names: %s",
    (name) => {
      expect(() => readMcpRequestMetadata(request(name))).not.toThrow();
    },
  );
  it.each(["=?base64?!!?=", "=?base64?/w==?=", "=?base64?YQ?="])(
    "rejects malformed encoded names: %s",
    (name) => {
      const input = request();
      input.headers.set("Mcp-Name", name);
      expect(() => readMcpRequestMetadata(input)).toThrow(
        expect.objectContaining({ code: -32020 }),
      );
    },
  );
  it("uses the URI for resources and does not require a target name for discovery", () => {
    const input = request("file:///資料");
    input.headers.set("Mcp-Method", "resources/read");
    expect(() =>
      readMcpRequestMetadata({
        ...input,
        method: "resources/read",
        params: { uri: input.params.name, _meta: input.params._meta },
      }),
    ).not.toThrow();
    input.headers.set("Mcp-Method", "server/discover");
    input.headers.delete("Mcp-Name");
    expect(() => readMcpRequestMetadata({ ...input, method: "server/discover" })).not.toThrow();
  });
  it.each([{}, { form: {} }, { form: {}, url: {} }])(
    "accepts declared form support %#",
    (elicitation) => {
      expect(() => requireMcpFormCapability({ elicitation })).not.toThrow();
    },
  );
  it.each([undefined, null, [], { url: {} }, { form: null }, { form: true }])(
    "rejects absent or malformed form support %#",
    (elicitation) => {
      expect(() => requireMcpFormCapability({ elicitation })).toThrow(
        expect.objectContaining({
          code: -32021,
          data: { requiredCapabilities: { elicitation: { form: {} } } },
        }),
      );
    },
  );
});

describe("tool parameter header mirrors", () => {
  it("checks nested string, integer and boolean arguments including encoded values", () => {
    const annotations = compileMcpParameterHeaders({
      type: "object",
      properties: {
        scope: {
          type: "object",
          properties: { region: { type: "string", "x-mcp-header": "Region" } },
        },
        count: { type: "integer", "x-mcp-header": "Count" },
        enabled: { type: "boolean", "x-mcp-header": "Enabled" },
      },
    });
    const headers = new Headers({
      "Mcp-Param-Region": encodeMcpHeaderValue("東京"),
      "Mcp-Param-Count": "3",
      "Mcp-Param-Enabled": "false",
    });
    expect(() =>
      validateMcpParameterHeaders(
        headers,
        { scope: { region: "東京" }, count: 3, enabled: false },
        annotations,
      ),
    ).not.toThrow();
    headers.set("Mcp-Param-Count", "4");
    expect(() =>
      validateMcpParameterHeaders(
        headers,
        { scope: { region: "東京" }, count: 3, enabled: false },
        annotations,
      ),
    ).toThrow("does not match");
  });
  it.each([
    { type: "object", properties: { bad: { type: "number", "x-mcp-header": "Bad" } } },
    {
      type: "object",
      properties: {
        a: { type: "string", "x-mcp-header": "Same" },
        b: { type: "string", "x-mcp-header": "same" },
      },
    },
    {
      type: "object",
      anyOf: [{ properties: { a: { type: "string", "x-mcp-header": "Hidden" } } }],
    },
    { type: "array", items: { type: "string", "x-mcp-header": "Item" } },
  ])("rejects invalid annotations at setup", (schema) => {
    expect(() => compileMcpParameterHeaders(schema)).toThrow("Invalid x-mcp-header");
  });
  it("distinguishes omitted optional arguments from unexpected headers", () => {
    const annotations = compileMcpParameterHeaders({
      type: "object",
      properties: { count: { type: "integer", "x-mcp-header": "Count" } },
    });
    expect(() => validateMcpParameterHeaders(new Headers(), {}, annotations)).not.toThrow();
    expect(() =>
      validateMcpParameterHeaders(new Headers({ "Mcp-Param-Count": "0" }), {}, annotations),
    ).toThrow("Unexpected");
  });
});
