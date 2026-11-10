import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { prepareChatInference } from "@sweatpan.ts/chat";
import {
  describePiAiModel,
  createPiAiProvider,
  type PiAiProviderOptions,
} from "@sweatpan.ts/providers-pi-ai";
import { measureContextBudget, type ModelRequest } from "@sweatpan.ts/providers";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: persisted usage backs local pi admission and changed prefixes invalidate it`, async () => {
    const sent: Record<string, unknown>[] = [];
    const paths: string[] = [];
    const estimates: ReturnType<typeof estimateContextTokens>[] = [];
    let limit = 50000;
    let nativeEdit = false;
    let prepareCalls = 0;
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      sent.push(JSON.parse(body));
      paths.push(request.url!);
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
        `data: ${JSON.stringify({ type: "response.completed", response: { id: "response_1", status: "completed", output: [item], usage: { input_tokens: 6000, output_tokens: 5, total_tokens: 6005 } } })}\n\n`,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing peer");
    }
    const model: PiAiProviderOptions["model"] = {
      id: "test",
      name: "test",
      api: "openai-responses",
      provider: "test",
      baseUrl: `http://127.0.0.1:${address.port}`,
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 50000,
      maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const run = async (request: ModelRequest, selected = model) => {
      const provider = createPiAiProvider(runtime, {
        model: selected,
        apiKey: "test-only",
        prepareContext(context) {
          prepareCalls++;
          // Preparation cannot smuggle an unvalidated accounting baseline into pi.
          for (const message of context.messages) {
            if (message.role === "assistant") {
              message.usage.totalTokens = 999999;
            }
          }
          if (nativeEdit) {
            for (const message of context.messages) {
              if (message.role === "assistant") {
                for (const part of message.content) {
                  if (part.type === "text") {
                    part.textSignature = JSON.stringify({ v: 1, id: "msg_1", phase: "commentary" });
                  }
                }
              }
            }
          }
          return context;
        },
        stream(selected, transcript, options) {
          const estimate = estimateContextTokens(transcript);
          estimates.push(estimate);
          return streamSimple({ ...selected, api: "openai-responses" }, transcript, {
            ...options,
            onPayload(value) {
              const tokens = estimate.tokens + Math.max(4096, Math.ceil(estimate.tokens * 0.15));
              if (
                !measureContextBudget(
                  { contextWindow: limit, maxOutputTokens: 512 },
                  { tokens, kind: "estimated" },
                  512,
                ).fits
              ) {
                throw new Error("Compaction required");
              }
              return { ...(value as Record<string, unknown>), max_output_tokens: 512 };
            },
          });
        },
      });
      return runtime.start(function* () {
        const subscription = yield* provider.stream(request);
        while (true) {
          const next = yield* subscription.next();
          if (next.done) {
            return next.value;
          }
        }
      }).result;
    };
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
    try {
      const first = await run(request);
      expect(first.message.contextUsage?.usage.total).toBe(6005);
      expect(estimates.at(-1)?.usageTokens).toBe(0);
      expect(sent[0]?.tools).toHaveLength(1);
      expect(JSON.stringify(sent[0]?.input)).toContain("input_image");
      const continuation: ModelRequest = JSON.parse(
        JSON.stringify({
          ...request,
          context: {
            ...request.context,
            messages: [
              ...request.context.messages,
              first.message,
              { role: "user", content: [{ type: "text", text: "Late feedback" }] },
            ],
          },
        }),
      );
      const prepared = prepareChatInference({
        model: describePiAiModel(model),
        history: continuation.context.messages.map((message) =>
          message.role === "assistant"
            ? { ...message, model: { id: model.id, api: model.api, provider: model.provider } }
            : message,
        ),
        tools: continuation.context.tools,
        options: continuation.options,
      });
      await run(prepared.request);
      expect(estimates.at(-1)?.usageTokens).toBe(6005);
      expect(estimates.at(-1)?.trailingTokens).toBeGreaterThan(0);
      expect(JSON.stringify(sent.at(-1))).not.toContain("contextUsage");
      expect(JSON.stringify(sent.at(-1))).toContain("msg_1");
      nativeEdit = true;
      await run(continuation);
      expect(estimates.at(-1)?.usageTokens).toBe(0);
      expect(JSON.stringify(sent.at(-1))).toContain("commentary");
      nativeEdit = false;
      await run(continuation);
      expect(estimates.at(-1)?.usageTokens).toBe(6005);
      const legacy = structuredClone(continuation);
      const legacyRequest: ModelRequest = {
        ...legacy,
        context: {
          ...legacy.context,
          messages: legacy.context.messages.map((message) =>
            message.role === "assistant" && message.contextUsage
              ? {
                  ...message,
                  contextUsage: {
                    ...message.contextUsage,
                    basis: {
                      ...message.contextUsage.basis,
                      format: "sweatpants/pi-context-usage/1",
                    },
                  },
                }
              : message,
          ),
        },
      };
      await run(legacyRequest);
      expect(estimates.at(-1)?.usageTokens).toBe(0);
      for (const change of ["prefix", "tools", "compaction", "output", "unknown"] as const) {
        let messages = [...structuredClone(continuation.context.messages)];
        if (change === "prefix") {
          messages[0] = { role: "user", content: [{ type: "text", text: "projected" }] };
        }
        if (change === "compaction") {
          messages = messages.slice(1);
        }
        messages = messages.map((message) => {
          if (message.role !== "assistant") {
            return message;
          }
          if (change === "output") {
            return { ...message, content: [{ type: "text", text: "edited" }] };
          }
          if (change === "unknown" && message.contextUsage) {
            return {
              ...message,
              contextUsage: {
                ...message.contextUsage,
                usage: { ...message.contextUsage.usage, total: null, input: null },
              },
            };
          }
          return message;
        });
        const changed: ModelRequest = {
          ...continuation,
          context: {
            ...continuation.context,
            messages,
            tools: change === "tools" ? [] : continuation.context.tools,
          },
        };
        await run(changed);
        expect(estimates.at(-1)?.usageTokens).toBe(0);
      }
      await run(continuation, { ...model, id: "other" });
      expect(estimates.at(-1)?.usageTokens).toBe(0);
      const before = sent.length;
      limit = 1000;
      await expect(run(continuation)).rejects.toThrow();
      expect(sent).toHaveLength(before);
      expect(paths.every((path) => path === "/responses")).toBe(true);
      expect(prepareCalls).toBe(estimates.length);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
