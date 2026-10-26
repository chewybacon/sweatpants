// @vitest-environment node
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { all, call, run, ensure, suspend } from "effection";
import { createDurableTool } from "@sweatpants/agent-sdk/primitive";
import { createMcpApp } from "@sweatpants/agent-host/mcp";
import { z } from "zod";
import { expect, it, vi } from "vitest";
import { SqliteJournal } from "@sweatpants/primitive-journal/sqlite";
import { MCP_PROTOCOL_VERSION } from "@sweatpants/tool-session/mcp";
import { mcpSingleChoice } from "../../../fixtures/mcp-single-choice.ts";
import { mcpRequest, useMcpServer } from "../../../support/mcp.ts";

for (const action of ["accept", "decline", "cancel"] as const) {
  it(`settles ${action} once and replays an identical MCP continuation`, async () => {
    await run(function* () {
      // Arrange: the primitive handler records an observable effect.
      let executions = 0;
      const server = yield* useMcpServer([mcpSingleChoice], {
        *"choose_number.count"() {
          executions++;
          return null;
        },
      });
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

      // Assert: the serialized result is retained without repeating the accepted effect.
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
    const server = yield* useMcpServer([mcpSingleChoice], {
      *"choose_number.count"() {
        executions++;
        return null;
      },
    });
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

    for (const malformed of [
      { action: "accept" },
      { action: "decline", extra: true },
      { action: "cancel", content: { number: 1 } },
    ]) {
      const rejected = yield* mcpRequest(server.origin, "tools/call", {
        ...continuation,
        inputResponses: { [key]: malformed },
      });
      expect(rejected.response.status).toBe(400);
    }

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
    const server = yield* useMcpServer([mcpSingleChoice], {
      *"choose_number.count"() {
        return null;
      },
    });
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

for (const stop of ["app-close", "reader-cancel", "demand-cancel"] as const) {
  it(`releases an active MCP effect and response reader on ${stop}`, async () => {
    // Observe real storage reads, not enqueues or a substitute evaluator. Snapshot
    // reads during execution are legitimate; response demand must not add any.
    const reads =
      stop === "demand-cancel" ? vi.spyOn(SqliteJournal.prototype, "readAccepted") : undefined;
    const snapshots =
      stop === "demand-cancel" ? vi.spyOn(SqliteJournal.prototype, "read") : undefined;
    let started!: () => void;
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    let disposed = 0;
    const tool = createDurableTool("waiting", { version: "1" })
      .description("Notify, then wait for native cancellation")
      .parameters(z.object({}))
      .effects({
        wait: {
          version: "1",
          input: z.null(),
          output: z.null(),
          retrySafety: { mode: "repeatable" },
        },
      })
      .elicits({})
      .execute(function* (_input, ctx) {
        yield* ctx.notify("working", 0.5);
        yield* ctx.log("info", "waiting");
        if (stop === "demand-cancel") {
          yield* ctx.log("info", "must remain unread");
        }
        yield* ctx.effect("wait", null);
        return {};
      });
    const app = createMcpApp({
      name: "cleanup",
      version: "1",
      secret: "cleanup-continuation-secret-at-least-32-bytes",
      tools: [tool],
      effects: {
        *"waiting.wait"() {
          yield* ensure(() => {
            disposed++;
          });
          started();
          yield* suspend();
          return null;
        },
      },
      *authenticate() {
        return "cleanup-client";
      },
    });
    try {
      const response = await app.handler(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
            "Mcp-Method": "tools/call",
            "Mcp-Name": "waiting",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "waiting",
              arguments: {},
              _meta: {
                progressToken: "cleanup-progress",
                "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/logLevel": "info",
              },
            },
          }),
        }),
      );
      await active;
      const snapshotCount = snapshots?.mock.calls.length;
      const reader = response.body!.getReader();
      // Let stream scheduling run with an accepted backlog but no reader demand.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(reads?.mock.calls.length ?? 0).toBe(0);
      const decode = (value?: Uint8Array) => new TextDecoder().decode(value);
      expect(decode((await reader.read()).value)).toContain('"progressToken":"cleanup-progress"');
      if (reads) {
        expect(reads.mock.calls).toEqual([[0]]);
      }
      expect(decode((await reader.read()).value)).toContain("notifications/message");
      if (reads) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(reads.mock.calls).toEqual([[0], [1]]);
        expect(snapshots!.mock.calls.length).toBe(snapshotCount);
        await reader.cancel();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(reads.mock.calls).toEqual([[0], [1]]);
        expect((await reader.read()).done).toBe(true);
        expect(disposed).toBe(1);
        return;
      }
      const waiting = reader.read();
      if (stop === "app-close") {
        await app.close();
        expect(decode((await waiting).value)).toContain('"error"');
      } else {
        await reader.cancel();
        expect((await waiting).done).toBe(true);
      }
      expect(disposed).toBe(1);
      await app.close();
      expect(disposed).toBe(1);
    } finally {
      await app.close();
      reads?.mockRestore();
      snapshots?.mockRestore();
    }
  });
}

// A synchronous vendor-independent schema deliberately accepts only raw strings.
// Revalidating its transformed numbers would fail, exposing replay boundary bugs.
const numericForm: StandardSchemaV1<{ value?: string }, { value: number }> = {
  "~standard": {
    version: 1 as const,
    vendor: "acceptance-numeric-form",
    validate(input: unknown) {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return { issues: [{ message: "Expected a form" }] };
      }
      const value = "value" in input ? input.value : "2";
      if (typeof value !== "string" || !/^\d+$/.test(value)) {
        return { issues: [{ message: "Expected numeric text" }] };
      }
      return { value: { value: Number(value) } };
    },
  },
};
const numericProjections = {
  inputProjection: { type: "object", properties: { value: { type: "string" } } },
  outputProjection: { type: "object", properties: { value: { type: "number" } } },
};

it("runs projected Standard Schemas through MCP and replays raw accepted answers and effects", async () => {
  const declaration = () =>
    createDurableTool("projected", { version: "1" }).description(
      "Transform a form through the journal",
    );
  expect(() =>
    declaration()
      .parameters(numericForm)
      .execute(function* () {
        return {};
      }),
  ).toThrow(/projection/);
  const tool = declaration()
    .parameters(numericForm, numericProjections)
    .output(numericForm, numericProjections)
    .effects({
      increment: {
        version: "1",
        input: numericForm,
        output: numericForm,
        inputProjections: numericProjections,
        outputProjections: numericProjections,
        retrySafety: { mode: "unsafe" },
      },
    })
    .elicits({
      choose: {
        response: numericForm,
        context: numericForm,
        responseProjections: numericProjections,
        contextProjections: numericProjections,
      },
    })
    .execute(function* (input, ctx) {
      const effect = yield* ctx.effect("increment", { value: String(input.value + 1) });
      const answer = yield* ctx.elicit("choose", {
        message: "Choose numeric text",
        context: { value: String(effect.value) },
      });
      return {
        value: String(effect.value + (answer.action === "accept" ? answer.content.value : 0)),
      };
    });
  await run(function* () {
    let executions = 0;
    const server = yield* useMcpServer(
      [tool],
      {
        *"projected.increment"(input) {
          executions++;
          expect(input).toEqual({ value: 30 });
          return { value: "40" };
        },
      },
      [
        {
          *effect([request], next) {
            expect(request.input).toEqual({ value: 3 });
            const outcome = yield* next({ ...request, input: { value: 30 } });
            expect(outcome).toEqual({ ok: true, value: { value: "40" } });
            return { ok: true, value: { value: "4" } };
          },
        },
      ],
    );
    const listed = yield* mcpRequest(server.origin, "tools/list", {});
    expect(listed.body.result.tools[0]._meta["x-sweatpants"].elicits.choose.context).toEqual(
      numericProjections.inputProjection,
    );
    const params = { name: "projected", arguments: {} };
    const called = yield* mcpRequest(server.origin, "tools/call", params);
    const pending = called.body.result;
    expect(pending.resultType).toBe("input_required");
    const key = Object.keys(pending.inputRequests)[0];
    expect(pending.inputRequests[key].params.requestedSchema["x-elicit-context"]).toEqual({
      value: "4",
    });
    const continuation = { ...params, requestState: pending.requestState };
    const invalid = yield* mcpRequest(server.origin, "tools/call", {
      ...continuation,
      inputResponses: { [key]: { action: "accept", content: { value: 5 } } },
    });
    expect(invalid.response.status).toBe(400);
    const accepted = {
      ...continuation,
      inputResponses: { [key]: { action: "accept", content: { value: "5" } } },
    };
    const completed = yield* mcpRequest(server.origin, "tools/call", accepted);
    const replayed = yield* mcpRequest(server.origin, "tools/call", accepted);
    expect(completed.body.result).toMatchObject({ resultType: "complete", isError: false });
    expect(JSON.parse(completed.body.result.content[0].text)).toEqual({ value: 9 });
    expect(replayed.body.result).toEqual(completed.body.result);
    expect(executions).toBe(1);
  });
});

it("reports invalid effect and tool outputs through MCP instead of successful completion", async () => {
  await run(function* () {
    const effectTool = createDurableTool("invalid_effect", { version: "1" })
      .description("Reject invalid effect output")
      .parameters(z.object({}))
      .effects({
        read: {
          version: "1",
          input: z.null(),
          output: numericForm,
          outputProjections: numericProjections,
          retrySafety: { mode: "repeatable" },
        },
      })
      .execute(function* (_input, ctx) {
        yield* ctx.effect("read", null);
        return {};
      });
    const outputTool = createDurableTool("invalid_output", { version: "1" })
      .description("Reject invalid tool output")
      .parameters(z.object({}))
      .output(z.string().min(2))
      .execute(function* () {
        return "";
      });
    for (const invalidAt of ["native", "middleware"] as const) {
      const server = yield* useMcpServer(
        [effectTool, outputTool],
        {
          *"invalid_effect.read"() {
            return { value: invalidAt === "native" ? 4 : "4" };
          },
        },
        [
          {
            *effect([request], next) {
              const outcome = yield* next(request);
              return invalidAt === "middleware" ? { ok: true, value: { value: 4 } } : outcome;
            },
          },
        ],
      );
      for (const name of ["invalid_effect", "invalid_output"]) {
        const result = yield* mcpRequest(server.origin, "tools/call", { name, arguments: {} });
        expect(result.body.result).toMatchObject({ resultType: "complete", isError: true });
      }
    }
  });
});

it("rejects asynchronous Standard Schema validators at the MCP boundary", async () => {
  const tool = createDurableTool("async_schema", { version: "1" })
    .description("Requires synchronous validation")
    .parameters(
      {
        "~standard": {
          ...numericForm["~standard"],
          async validate() {
            return { value: { value: 2 } };
          },
        },
      },
      numericProjections,
    )
    .execute(function* () {
      return {};
    });
  await run(function* () {
    const server = yield* useMcpServer([tool]);
    const result = yield* mcpRequest(server.origin, "tools/call", {
      name: tool.name,
      arguments: {},
    });
    expect(result.response.status).toBe(400);
    expect(result.body.error.code).toBe(-32602);
  });
});
