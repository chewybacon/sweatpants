import { afterEach, expect, it, vi } from "vitest";
import { authoringPolicy, fetchWithAuthoringPolicy } from "../authoring.ts";

afterEach(() => vi.unstubAllGlobals());

it("adds task-independent policy while preserving the authored chat command and headers", async () => {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    requests.push(request);
    return new Response("ok");
  });
  await fetchWithAuthoringPolicy("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Request-ID": "one" },
    body: JSON.stringify({
      command: { type: "send-message" },
      userMessage: { content: "Make a list" },
    }),
  });
  expect(await requests[0].json()).toEqual({
    command: { type: "send-message" },
    userMessage: { content: "Make a list" },
    systemPrompt: authoringPolicy,
  });
  expect(requests[0].headers.get("X-Request-ID")).toBe("one");
});

it("leaves history reads and other endpoints untouched", async () => {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    requests.push(request);
    return new Response("ok");
  });
  await fetchWithAuthoringPolicy("http://localhost/api/chat/history");
  expect(requests[0].method).toBe("GET");
  expect(await requests[0].text()).toBe("");
});
