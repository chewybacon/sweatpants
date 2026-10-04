import { describe, expect, it } from "vitest";
import { run } from "effection";
import { createMcpContinuations, decodeMcpFormResponse } from "../continuations.ts";

const secret = "test-secret-with-at-least-thirty-two-bytes";
const binding = {
  serverId: "server",
  callerId: "alice",
  method: "tools/call",
  params: { name: "pick", arguments: { count: 3 } },
};
const reference = { invocationId: "invocation", pullId: "pull" };

describe("MCP continuations", () => {
  it("survives recreation and key rotation without consuming the token", async () => {
    const first = createMcpContinuations({ secret, now: () => 100 });
    const token = await run(() => first.issue(binding, reference));
    const replacement = createMcpContinuations({
      secret: "rotated-secret-with-at-least-thirty-two-bytes",
      verificationSecrets: [secret],
      now: () => 101,
    });
    expect(await run(() => replacement.verify(token, binding))).toEqual(reference);
    expect(await run(() => replacement.verify(token, binding))).toEqual(reference);
    const retired = createMcpContinuations({
      secret: "rotated-secret-with-at-least-thirty-two-bytes",
      now: () => 101,
    });
    await expect(run(() => retired.verify(token, binding))).rejects.toMatchObject({
      code: "mcp_continuation_invalid",
    });
  });

  it.each([
    { ...binding, serverId: "other" },
    { ...binding, callerId: "mallory" },
    { ...binding, method: "resources/read" },
    { ...binding, params: { name: "pick", arguments: { count: 4 } } },
  ])("rejects changed request identity %#", async (changed) => {
    const codec = createMcpContinuations({ secret });
    const token = await run(() => codec.issue(binding, reference));
    await expect(run(() => codec.verify(token, changed))).rejects.toMatchObject({
      code: "mcp_continuation_binding_mismatch",
    });
  });

  it("canonicalizes argument key order and excludes caller data from the payload", async () => {
    const codec = createMcpContinuations({ secret });
    const token = await run(() => codec.issue(binding, reference));
    expect(
      await run(() =>
        codec.verify(token, { ...binding, params: { arguments: { count: 3 }, name: "pick" } }),
      ),
    ).toEqual(reference);
    const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
    expect(payload).toEqual({
      version: 1,
      binding: expect.any(String),
      reference,
      issuedAt: expect.any(Number),
      expiresAt: expect.any(Number),
    });
    expect(JSON.stringify(payload)).not.toContain("alice");
  });

  it("enforces expiry and rejects clocks before issuance", async () => {
    let now = 100;
    const codec = createMcpContinuations({ secret, ttlMs: 10, now: () => now });
    const token = await run(() => codec.issue(binding, reference));
    now = 109;
    expect(await run(() => codec.verify(token, binding))).toEqual(reference);
    now = 110;
    await expect(run(() => codec.verify(token, binding))).rejects.toMatchObject({
      code: "mcp_continuation_expired",
    });
    now = 99;
    await expect(run(() => codec.verify(token, binding))).rejects.toMatchObject({
      code: "mcp_continuation_invalid",
    });
  });

  it("rejects tampering, malformed encodings, and oversized tokens", async () => {
    const codec = createMcpContinuations({ secret });
    const token = await run(() => codec.issue(binding, reference));
    const tampered = `${token[0] === "A" ? "B" : "A"}${token.slice(1)}`;
    for (const invalid of [tampered, "", "a.b.c", "!.a", "a.a", "a".repeat(16385)]) {
      await expect(run(() => codec.verify(invalid, binding))).rejects.toMatchObject({
        code: "mcp_continuation_invalid",
      });
    }
    await expect(
      run(() =>
        codec.issue(binding, {
          invocationId: "\u0000".repeat(1024),
          pullId: "\u0000".repeat(1024),
        }),
      ),
    ).rejects.toMatchObject({ code: "mcp_continuation_invalid" });
  });

  it("rejects invalid configuration", () => {
    expect(() => createMcpContinuations({ secret: "short" })).toThrow("32 to 4096");
    expect(() => createMcpContinuations({ secret, ttlMs: 0 })).toThrow("TTL");
    expect(() =>
      createMcpContinuations({ secret, verificationSecrets: Array(8).fill(secret) }),
    ).toThrow("eight");
  });
});

describe("MCP form responses", () => {
  it("decodes flat accepted content and both non-accept outcomes", () => {
    const response = {
      action: "accept",
      content: { picked: "ace", count: 1, enabled: true, tags: ["a"] },
    };
    expect(decodeMcpFormResponse({ pull: response }, "pull")).toEqual(response);
    expect(decodeMcpFormResponse({ pull: { action: "decline" } }, "pull")).toEqual({
      action: "decline",
    });
    expect(decodeMcpFormResponse({ pull: { action: "cancel" } }, "pull")).toEqual({
      action: "cancel",
    });
  });
  it.each([
    {},
    { wrong: { action: "decline" } },
    { pull: { action: "decline" }, extra: { action: "cancel" } },
    { pull: { action: "accept" } },
    { pull: { action: "accept", content: { picked: { rank: "ace" } } } },
    { pull: { action: "decline", content: {} } },
    { pull: { action: "cancel", content: {} } },
  ])("rejects unmatched or malformed input %#", (input) => {
    expect(() => decodeMcpFormResponse(input, "pull")).toThrow("pending form");
  });
});
