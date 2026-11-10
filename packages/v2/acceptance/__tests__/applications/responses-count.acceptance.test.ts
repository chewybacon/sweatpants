import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
  createPiAiProvider,
  type PiAiProviderOptions,
  type ResponsesCountInput,
} from "@sweatpan.ts/providers-pi-ai";
import type { ModelRequest } from "@sweatpan.ts/providers";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { createResponsesInputCounter } from "@sweatpan.ts/providers-pi-ai";
import { measureContextBudget, type Json } from "@sweatpan.ts/providers";

it("Responses counting measures explicit input, preserves budget provenance and rejects unavailable counts", async () => {
  const requests: unknown[] = [];
  let status = 200;
  let hold = false;
  let received: () => void = () => {};
  let result: unknown = { object: "response.input_tokens", input_tokens: 872 };
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
    }
    requests.push({ path: request.url, body: JSON.parse(body) });
    if (hold) {
      received();
      return;
    }
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing peer address");
    }
    const counter = createResponsesInputCounter({
      endpoint: `http://127.0.0.1:${address.port}/v1/`,
      headers: { Authorization: "Bearer test-only" },
    });
    expect(requests).toEqual([]);
    const input: { model: string; input: Json[]; tools: Json[] } = {
      model: "selected",
      input: [
        { type: "reasoning", encrypted_content: "opaque" },
        {
          type: "function_call_output",
          call_id: "call",
          output: [{ type: "input_image", image_url: "data:image/png;base64,aA==" }],
        },
      ],
      tools: [{ type: "function", name: "inspect", parameters: { type: "object" } }],
    };
    const snapshot = structuredClone(input);
    const pending = counter.count(input, new AbortController().signal);
    input.model = "changed-after-call";
    const count = await pending;
    expect(count).toEqual({ tokens: 872, kind: "measured" });
    expect(requests).toEqual([{ path: "/v1/responses/input_tokens", body: snapshot }]);
    expect(
      measureContextBudget({ contextWindow: 1000, maxOutputTokens: 200 }, count, 128).fits,
    ).toBe(true);
    expect(
      measureContextBudget({ contextWindow: 999, maxOutputTokens: 200 }, count, 128).fits,
    ).toBe(false);
    for (const invalid of [-1, 1.5, "123", null]) {
      result = { object: "response.input_tokens", input_tokens: invalid };
      await expect(counter.count(snapshot, new AbortController().signal)).rejects.toThrow(
        "Invalid Responses input token count",
      );
    }
    result = { object: "wrong", input_tokens: 100 };
    await expect(counter.count(snapshot, new AbortController().signal)).rejects.toThrow(
      "Invalid Responses input token count",
    );
    status = 404;
    result = { error: "private provider detail" };
    await expect(counter.count(snapshot, new AbortController().signal)).rejects.toThrow(
      /^Responses input counting returned HTTP 404$/,
    );
    const before = requests.length;
    const aborted = new AbortController();
    aborted.abort();
    await expect(counter.count(snapshot, aborted.signal)).rejects.toThrow();
    expect(requests).toHaveLength(before);
    await expect(
      counter.count(
        Object.assign({}, snapshot, { instructions: "unaccounted instruction" }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("Expected explicit");
    expect(requests).toHaveLength(before);
    hold = true;
    const started = new Promise<void>((resolve) => {
      received = resolve;
    });
    const active = new AbortController();
    const pendingCount = counter.count(snapshot, active.signal);
    await started;
    active.abort();
    await expect(pendingCount).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const mode of ["fits", "overflow", "unavailable", "cancel"] as const) {
    it(`${runtime.name}: pi payload counting gates real SDK inference (${mode})`, async () => {
      const counted: Record<string, unknown>[] = [];
      const sent: Record<string, unknown>[] = [];
      let started: () => void = () => {};
      const counting = new Promise<void>((resolve) => {
        started = resolve;
      });
      const server = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) {
          body += chunk;
        }
        const payload = JSON.parse(body);
        if (request.url === "/responses/input_tokens") {
          counted.push(payload);
          started();
          if (mode === "cancel") {
            return;
          }
          response.writeHead(mode === "unavailable" ? 404 : 200, {
            "Content-Type": "application/json",
          });
          response.end(
            JSON.stringify({
              object: "response.input_tokens",
              input_tokens: mode === "overflow" ? 489 : 488,
            }),
          );
          return;
        }
        sent.push(payload);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const item = {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "answer", annotations: [] }],
        };
        response.write(
          `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n`,
        );
        response.end(
          `data: ${JSON.stringify({ type: "response.completed", response: { id: "response_1", status: "completed", output: [item], usage: { input_tokens: 488, output_tokens: 5, total_tokens: 493 } } })}\n\n`,
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing protocol peer");
      }
      const endpoint = `http://127.0.0.1:${address.port}`;
      const model: PiAiProviderOptions["model"] = {
        id: "test",
        name: "test",
        api: "openai-responses",
        provider: "test",
        baseUrl: endpoint,
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 1000,
        maxTokens: 512,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      const counter = createResponsesInputCounter({
        endpoint,
        headers: { Authorization: "Bearer test-only" },
      });
      let preflightError: unknown;
      const provider = createPiAiProvider(runtime, {
        model,
        apiKey: "test-only",
        stream(selected, context, options) {
          return streamSimple({ ...selected, api: "openai-responses" }, normalizeContext(context), {
            ...options,
            async onPayload(value) {
              try {
                // App policy overrides pi's estimated output clamp before measuring.
                const payload: Record<string, unknown> = {
                  ...(value as Record<string, unknown>),
                  max_output_tokens: 512,
                };
                const input = {
                  model: payload.model,
                  input: payload.input,
                  tools: payload.tools ?? [],
                } as ResponsesCountInput;
                const count = await counter.count(input, options.signal!);
                if (
                  measureContextBudget({ contextWindow: 1000, maxOutputTokens: 512 }, count, 512)
                    .fits !== true
                ) {
                  throw new Error("Compaction required");
                }
                return payload;
              } catch (error) {
                preflightError = error;
                throw error;
              }
            },
          });
        },
      });
      const request: ModelRequest = {
        context: {
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Late host feedback" },
                {
                  type: "image",
                  source: { type: "data", mimeType: "image/png", value: "aA==" },
                  metadata: null,
                },
              ],
            },
          ],
          tools: [
            {
              name: "inspect",
              description: "Inspect",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
        options: { maxTokens: 512 },
      };
      const task = runtime.start(function* () {
        const subscription = yield* provider.stream(request);
        while (true) {
          const next = yield* subscription.next();
          if (next.done) {
            return next.value;
          }
        }
      });
      void task.result.catch(() => undefined);
      try {
        if (mode === "cancel") {
          await counting;
          await task.cancel();
        } else if (mode !== "fits") {
          await expect(task.result).rejects.toThrow();
          expect(preflightError).toBeInstanceOf(Error);
        } else {
          expect((await task.result).message.content).toEqual([{ type: "text", text: "answer" }]);
          expect(sent).toHaveLength(1);
          expect(sent[0]?.max_output_tokens).toBe(512);
          expect(counted[0]).toEqual({
            model: sent[0]?.model,
            input: sent[0]?.input,
            tools: sent[0]?.tools,
          });
          expect(sent[0]?.tools).toHaveLength(1);
          expect(JSON.stringify(sent[0]?.input)).toContain("input_image");
        }
        expect(counted).toHaveLength(1);
        if (mode !== "fits") {
          expect(sent).toHaveLength(0);
        }
      } finally {
        await task.cancel();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  }
});
