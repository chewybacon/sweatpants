import { expect, it, vi } from "vitest";
import { createScope } from "effection";

vi.mock("@sweatpants/storage-sqlite/better-sqlite3", () => {
  throw new Error("Native Node storage is unavailable in this runtime");
});
vi.mock("@sweatpants/storage-postgres/pg-binding", () => {
  throw new Error("Native Node storage is unavailable in this runtime");
});

it("resolves portable storage without importing any native Node backend", async () => {
  const { chatStorageForScope } = await import("../storage.ts");
  const [scope, close] = createScope();
  try {
    const memory = await chatStorageForScope({ kind: "memory" }, scope);
    const custom = await chatStorageForScope({ kind: "custom", ...memory }, scope);
    expect(custom.conversationStore).toBe(memory.conversationStore);
    expect(custom.executionStore).toBe(memory.executionStore);
    // An explicit Node backend selection still loads that backend and fails loudly.
    await expect(chatStorageForScope({ kind: "sqlite", path: ":memory:" }, scope)).rejects.toThrow(
      /Native Node storage|error when mocking/,
    );
  } finally {
    await close();
  }
});
