import { describe, expect, it } from "vitest";
import { startYoMcpServer } from "../server.ts";
import { MCP_PROTOCOL_VERSION } from "@sweatpants/tool-session/mcp";

async function rpc(
  origin: string,
  method: string,
  params: Record<string, unknown> = {},
  capabilities: Record<string, unknown> = { elicitation: { form: {} }, sampling: {} },
) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      "Mcp-Method": method,
      /* CONDITIONAL-SPREAD: HTTP headers must omit absent "Mcp-Name"; undefined is not a header value. */
      ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": capabilities,
        },
      },
    }),
  });
  const text = await response.text();
  const messages = response.headers.get("content-type")?.includes("text/event-stream")
    ? [...text.matchAll(/^data: (.*)$/gm)].map((match) => JSON.parse(match[1]))
    : [JSON.parse(text)];
  return { response, body: messages.at(-1), messages };
}

describe("yo-mcp modern HTTP composition", () => {
  it("discovers, lists and executes independent calls without transport sessions", async () => {
    const server = await startYoMcpServer(0);
    try {
      const preflight = await fetch(`${server.origin}/mcp`, { method: "OPTIONS" });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
      const discover = await rpc(server.origin, "server/discover");
      expect(discover.body.result).toMatchObject({
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
      });
      expect(discover.response.headers.has("mcp-session-id")).toBe(false);
      const list = await rpc(server.origin, "tools/list");
      expect(list.body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
        "confirm",
        "echo",
        "greet",
        "pick_card",
        "plan_trip",
      ]);
      for (const message of ["first", "second"]) {
        const called = await rpc(server.origin, "tools/call", {
          name: "echo",
          arguments: { message, uppercase: true },
        });
        expect(called.response.status).toBe(200);
        expect(called.body.result.resultType).toBe("complete");
        expect(JSON.parse(called.body.result.content[0].text)).toEqual({
          echoed: message.toUpperCase(),
          length: message.length,
        });
      }
    } finally {
      await server.close();
    }
  });

  it.each(["accept", "decline", "cancel"] as const)(
    "handles card %s and an identical continuation retry",
    async (action) => {
      const server = await startYoMcpServer(0);
      try {
        const params = { name: "pick_card", arguments: { count: 3 } };
        const called = await rpc(server.origin, "tools/call", params);
        expect(called.body.result.resultType).toBe("input_required");
        const result = called.body.result;
        const requestId = Object.keys(result.inputRequests)[0];
        expect(result.inputRequests[requestId]).toMatchObject({
          method: "elicitation/create",
          params: {
            mode: "form",
            requestedSchema: {
              type: "object",
              properties: { cardNumber: { type: "number", minimum: 1 } },
              required: ["cardNumber"],
            },
          },
        });
        expect(
          result.inputRequests[requestId].params.requestedSchema["x-elicit-context"],
        ).toMatchObject({ cards: expect.any(Array) });
        // No independent server JSON-RPC requests travel on the response stream.
        expect(called.messages.every((message) => !(message.method && message.id))).toBe(true);
        const retry = {
          ...params,
          requestState: result.requestState,
          inputResponses: {
            [requestId]: {
              action /* CONDITIONAL-SPREAD: Omit absent content from MCP request and interaction payloads; explicit undefined is not a portable JSON value. */,
              ...(action === "accept" ? { content: { cardNumber: 1 } } : {}),
            },
          },
        };
        const completed = await rpc(server.origin, "tools/call", retry);
        expect(completed.body.result).toMatchObject({ resultType: "complete", isError: false });
        expect(JSON.parse(completed.body.result.content[0].text).success).toBe(action === "accept");
        const duplicate = await rpc(server.origin, "tools/call", retry);
        expect(duplicate.body.result).toEqual(completed.body.result);
        const next = await rpc(server.origin, "tools/call", {
          name: "echo",
          arguments: { message: "after card" },
        });
        expect(JSON.parse(next.body.result.content[0].text).echoed).toBe("after card");
      } finally {
        await server.close();
      }
    },
  );

  it("resumes sampling with a client-provided response", async () => {
    const server = await startYoMcpServer(0);
    try {
      const params = { name: "greet", arguments: { name: "Alice", style: "casual" } };
      const called = await rpc(server.origin, "tools/call", params);
      const pending = called.body.result;
      expect(pending.resultType).toBe("input_required");
      const requestId = Object.keys(pending.inputRequests)[0];
      expect(pending.inputRequests[requestId].method).toBe("sampling/createMessage");
      const completed = await rpc(server.origin, "tools/call", {
        ...params,
        requestState: pending.requestState,
        inputResponses: {
          [requestId]: {
            role: "assistant",
            content: { type: "text", text: "Hello Alice!" },
            model: "test",
            stopReason: "endTurn",
          },
        },
      });
      expect(JSON.parse(completed.body.result.content[0].text)).toEqual({
        name: "Alice",
        style: "casual",
        greeting: "Hello Alice!",
      });
    } finally {
      await server.close();
    }
  });
  it("validates browser origins against the actual listening address", async () => {
    const server = await startYoMcpServer(0);
    try {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      });
      for (const [origin, expected] of [
        [server.origin, 200],
        ["https://untrusted.example", 403],
      ] as const) {
        const response = await fetch(`${server.origin}/mcp`, {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "Mcp-Method": "server/discover",
            "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
          },
          body,
        });
        expect(response.status).toBe(expected);
        await response.text();
      }
    } finally {
      await server.close();
    }
  });

  it("rejects invalid continuations and answers without consuming the pending input", async () => {
    const server = await startYoMcpServer(0);
    try {
      const params = { name: "pick_card", arguments: { count: 3 } };
      const called = await rpc(server.origin, "tools/call", params);
      const pending = called.body.result;
      const key = Object.keys(pending.inputRequests)[0];
      const retry = {
        ...params,
        requestState: pending.requestState,
        inputResponses: { [key]: { action: "accept", content: { cardNumber: 1 } } },
      };
      const missingCapability = await rpc(server.origin, "tools/call", retry, {});
      expect(missingCapability.response.status).toBe(400);
      expect(missingCapability.body.error.code).toBe(-32021);
      const altered = await rpc(server.origin, "tools/call", { ...retry, arguments: { count: 4 } });
      expect(altered.response.status).toBe(400);
      const tampered = await rpc(server.origin, "tools/call", {
        ...retry,
        requestState: pending.requestState + "x",
      });
      expect(tampered.response.status).toBe(400);
      const invalidAnswer = await rpc(server.origin, "tools/call", {
        ...retry,
        inputResponses: { [key]: { action: "accept", content: { cardNumber: 0 } } },
      });
      expect(invalidAnswer.response.status).toBe(400);
      expect(invalidAnswer.body.error.code).toBe(-32602);
      const [first, duplicate] = await Promise.all([
        rpc(server.origin, "tools/call", retry),
        rpc(server.origin, "tools/call", retry),
      ]);
      expect(first.body.result).toMatchObject({ resultType: "complete", isError: false });
      expect(duplicate.body.result).toEqual(first.body.result);
      const conflict = await rpc(server.origin, "tools/call", {
        ...retry,
        inputResponses: { [key]: { action: "decline" } },
      });
      expect(conflict.body.error.code).toBe(-32602);
    } finally {
      await server.close();
    }
  });
});

describe("multi-turn trip planning", () => {
  it("keeps answers across five interactions, revises, and retries without advancing twice", async () => {
    const server = await startYoMcpServer(0);
    try {
      const params = { name: "plan_trip", arguments: { traveler: "Ada" } };
      const started = await rpc(server.origin, "tools/call", params);
      const destination = started.body.result;
      expect(destination.resultType).toBe("input_required");
      const destinationId = Object.keys(destination.inputRequests)[0];
      expect(destination.inputRequests[destinationId].params.message).toContain("Ada");
      const answerDestination = {
        ...params,
        requestState: destination.requestState,
        inputResponses: { [destinationId]: { action: "accept", content: { city: "Kyoto" } } },
      };
      const selected = await rpc(server.origin, "tools/call", answerDestination);
      const activity = selected.body.result;
      expect(activity.resultType).toBe("input_required");
      const activityId = Object.keys(activity.inputRequests)[0];
      expect(activity.inputRequests[activityId].params.message).toContain("Kyoto");
      const duplicate = await rpc(server.origin, "tools/call", answerDestination);
      expect(duplicate.body.result.inputRequests).toEqual(activity.inputRequests);

      const proposed = await rpc(server.origin, "tools/call", {
        ...params,
        requestState: activity.requestState,
        inputResponses: { [activityId]: { action: "accept", content: { activity: "museum" } } },
      });
      const review = proposed.body.result;
      expect(review.resultType).toBe("input_required");
      const reviewId = Object.keys(review.inputRequests)[0];
      expect(review.inputRequests[reviewId].params.message).toContain("Ada: Kyoto, with a museum");
      const revised = await rpc(server.origin, "tools/call", {
        ...params,
        requestState: review.requestState,
        inputResponses: { [reviewId]: { action: "accept", content: { confirmed: false } } },
      });
      const nextActivity = revised.body.result;
      expect(nextActivity.resultType).toBe("input_required");
      const nextActivityId = Object.keys(nextActivity.inputRequests)[0];
      expect(nextActivity.inputRequests[nextActivityId].params.message).toContain("Kyoto");
      const reproposed = await rpc(server.origin, "tools/call", {
        ...params,
        requestState: nextActivity.requestState,
        inputResponses: { [nextActivityId]: { action: "accept", content: { activity: "park" } } },
      });
      const nextReview = reproposed.body.result;
      expect(nextReview.resultType).toBe("input_required");
      const nextReviewId = Object.keys(nextReview.inputRequests)[0];
      expect(nextReview.inputRequests[nextReviewId].params.message).toContain(
        "Ada: Kyoto, with a park",
      );
      expect(
        new Set([destinationId, activityId, reviewId, nextActivityId, nextReviewId]).size,
      ).toBe(5);
      const answerReview = {
        ...params,
        requestState: nextReview.requestState,
        inputResponses: { [nextReviewId]: { action: "accept", content: { confirmed: true } } },
      };
      const completed = await rpc(server.origin, "tools/call", answerReview);
      expect(completed.body.result).toMatchObject({ resultType: "complete", isError: false });
      expect(JSON.parse(completed.body.result.content[0].text)).toEqual({
        status: "planned",
        traveler: "Ada",
        city: "Kyoto",
        activity: "park",
      });
      const completedAgain = await rpc(server.origin, "tools/call", answerReview);
      expect(completedAgain.body.result).toEqual(completed.body.result);
    } finally {
      await server.close();
    }
  });

  it.each([
    ["destination", "cancel", 0],
    ["destination", "decline", 0],
    ["activity", "cancel", 1],
    ["activity", "decline", 1],
    ["review", "cancel", 2],
    ["review", "decline", 2],
  ] as const)("ends at %s on %s", async (stage, action, answers) => {
    const server = await startYoMcpServer(0);
    try {
      const params = { name: "plan_trip", arguments: { traveler: "Ada" } };
      let pending = (await rpc(server.origin, "tools/call", params)).body.result;
      const contents = [{ city: "Kyoto" }, { activity: "museum" }];
      for (const content of contents.slice(0, answers)) {
        expect(pending.resultType).toBe("input_required");
        const id = Object.keys(pending.inputRequests)[0];
        pending = (
          await rpc(server.origin, "tools/call", {
            ...params,
            requestState: pending.requestState,
            inputResponses: { [id]: { action: "accept", content } },
          })
        ).body.result;
      }
      expect(pending.resultType).toBe("input_required");
      const id = Object.keys(pending.inputRequests)[0];
      const completed = await rpc(server.origin, "tools/call", {
        ...params,
        requestState: pending.requestState,
        inputResponses: { [id]: { action } },
      });
      expect(completed.body.result).toMatchObject({ resultType: "complete", isError: false });
      expect(JSON.parse(completed.body.result.content[0].text)).toEqual({ status: action, stage });
    } finally {
      await server.close();
    }
  });
});
