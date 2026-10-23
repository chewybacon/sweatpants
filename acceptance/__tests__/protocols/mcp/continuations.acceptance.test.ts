// @vitest-environment node
import { all, call, run } from "effection";
import { expect, it } from "vitest";
import { MCP_PROTOCOL_VERSION } from "@sweatpants/tool-session/mcp";
import { createSingleChoice } from "../../../fixtures/single-choice.ts";
import { mcpRequest, useMcpServer } from "../../../support/mcp.ts";

for (const action of ["accept", "decline", "cancel"] as const) {
  it(`settles ${action} once and replays an identical MCP continuation`, async () => {
    await run(function* () {
      // Arrange: the execution adapter runs the authored generator body.
      let executions = 0;
      const server = yield* useMcpServer([createSingleChoice(() => executions++)]);
      const params = { name: "choose_number", arguments: { count: 3 } };

      // Act: start the invocation and inspect its typed continuation request.
      const called = yield* mcpRequest(server.origin, "tools/call", params);
      const pending = called.body.result;
      expect(pending.resultType).toBe("input_required");
      const requestId = Object.keys(pending.inputRequests)[0];
      expect(pending.inputRequests[requestId]).toMatchObject({
        method: "elicitation/create",
        params: {
          mode: "form",
          requestedSchema: {
            type: "object",
            properties: { number: { type: "number", minimum: 1 } },
            required: ["number"],
            "x-elicit-context": { options: [1, 2, 3] },
          },
        },
      });
      expect(called.messages.every((message) => !(message.method && message.id))).toBe(true);
      const answer = action === "accept" ? { action, content: { number: 1 } } : { action };
      const continuation = {
        ...params,
        requestState: pending.requestState,
        inputResponses: { [requestId]: answer },
      };

      // Act: settle, then retry exactly the same continuation.
      const completed = yield* mcpRequest(server.origin, "tools/call", continuation);
      const duplicate = yield* mcpRequest(server.origin, "tools/call", continuation);

      // Assert: the serialized result is retained without another body entry.
      expect(completed.body.result).toMatchObject({ resultType: "complete", isError: false });
      expect(JSON.parse(completed.body.result.content[0].text)).toEqual({
        action,
        selected: action === "accept" ? 1 : null,
      });
      expect(duplicate.body.result).toEqual(completed.body.result);
      expect(executions).toBe(1);
    });
  });
}

it("rejects invalid MCP continuations without consuming the pending answer", async () => {
  await run(function* () {
    // Arrange
    let executions = 0;
    const server = yield* useMcpServer([createSingleChoice(() => executions++)]);
    const params = { name: "choose_number", arguments: { count: 3 } };
    const called = yield* mcpRequest(server.origin, "tools/call", params);
    const pending = called.body.result;
    expect(pending.resultType).toBe("input_required");
    const key = Object.keys(pending.inputRequests)[0];
    const continuation = {
      ...params,
      requestState: pending.requestState,
      inputResponses: { [key]: { action: "accept", content: { number: 1 } } },
    };

    // Act / Assert: reject missing capability, changed arguments, tampering and invalid content.
    const missingCapability = yield* mcpRequest(server.origin, "tools/call", continuation, {});
    expect(missingCapability.response.status).toBe(400);
    expect(missingCapability.body.error.code).toBe(-32021);
    const altered = yield* mcpRequest(server.origin, "tools/call", {
      ...continuation,
      arguments: { count: 4 },
    });
    expect(altered.response.status).toBe(400);
    const tampered = yield* mcpRequest(server.origin, "tools/call", {
      ...continuation,
      requestState: pending.requestState + "x",
    });
    expect(tampered.response.status).toBe(400);
    const invalid = yield* mcpRequest(server.origin, "tools/call", {
      ...continuation,
      inputResponses: { [key]: { action: "accept", content: { number: 0 } } },
    });
    expect(invalid.response.status).toBe(400);
    expect(invalid.body.error.code).toBe(-32602);

    // Act: submit two valid continuations concurrently at the HTTP boundary.
    const [first, duplicate] = yield* all([
      mcpRequest(server.origin, "tools/call", continuation),
      mcpRequest(server.origin, "tools/call", continuation),
    ]);
    expect(first.body.result).toMatchObject({ resultType: "complete", isError: false });
    expect(duplicate.body.result).toEqual(first.body.result);
    const conflict = yield* mcpRequest(server.origin, "tools/call", {
      ...continuation,
      inputResponses: { [key]: { action: "decline" } },
    });
    expect(conflict.body.error.code).toBe(-32602);
    expect(executions).toBe(1);
  });
});

it("validates MCP browser origins against the actual listening address", async () => {
  await run(function* () {
    // Arrange
    const server = yield* useMcpServer([createSingleChoice()]);
    for (const [origin, expected] of [
      [server.origin, 200],
      ["https://untrusted.example", 403],
    ] as const) {
      // Act
      const response = yield* call(() =>
        fetch(`${server.origin}/mcp`, {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "Mcp-Method": "server/discover",
            "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "server/discover",
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        }),
      );

      // Assert
      expect(response.status).toBe(expected);
      yield* call(() => response.text());
    }
  });
});
