import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { createResponsesInputCounter } from "@sweatpan.ts/providers-openai";
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
