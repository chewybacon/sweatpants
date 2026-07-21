import { describe, expect, it } from "vitest";
import { startModelSimulator } from "./model.ts";

describe("model semantic barriers", () => {
  it("matches before responding and manually releases text chunks", async () => {
    const simulator = await startModelSimulator();
    try {
      const expected = simulator.model.expectRequest({ model: "test", stream: true });
      const responsePromise = fetch(`${simulator.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-client-request-id": "pull-1" },
        body: JSON.stringify({ model: "test", stream: true }),
      });
      const pending = await expected;
      expect(pending.pullId).toBe("pull-1");
      const stream = await pending.respond.text({ chunks: ["a", "b"], release: "manual" });
      await stream.releaseNext();
      await stream.finish();
      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"delta":"a"');
      simulator.verify();
    } finally {
      await simulator.close();
    }
  });

  it("fails verification while a captured request remains unanswered", async () => {
    const simulator = await startModelSimulator();
    try {
      const expected = simulator.model.expectRequest({ model: "test", stream: true });
      void fetch(`${simulator.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "test", stream: true }),
      }).catch(() => undefined);
      await expected;
      expect(() => simulator.verify()).toThrow("1 unanswered model request");
    } finally {
      await simulator.close();
    }
  });

  it("returns an immediate OpenAI-shaped error for an unexpected request", async () => {
    let poisoned: Error | undefined;
    const simulator = await startModelSimulator((error) => {
      poisoned = error;
    });
    try {
      const response = await fetch(`${simulator.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "test", stream: true }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "simulator_unexpected_request" },
      });
      expect(poisoned).toBeInstanceOf(Error);
    } finally {
      await simulator.close();
    }
  });
});
