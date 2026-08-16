import { describe, expect, it } from "vitest";
import {
  createRegistry,
  RegistryEntryMissingError,
  RegistryNameConflictError,
} from "./registry-style.ts";

type Implementation = {
  readonly id: string;
  readonly run: () => string;
};

const fast: Implementation = { id: "fast", run: () => "fast" };
const safe: Implementation = { id: "safe", run: () => "safe" };

describe("generic immutable registry style", () => {
  it("copies entries and exposes deterministic exact-name lookup", () => {
    const source = new Map<string, Implementation>([
      ["safe", safe],
      ["fast", fast],
    ]);
    const registry = createRegistry("models", source);
    source.set("unsafe", { id: "unsafe", run: () => "unsafe" });

    expect(registry.name).toBe("models");
    expect(registry.names).toEqual(["fast", "safe"]);
    expect(registry.size).toBe(2);
    expect(registry.has("fast")).toBe(true);
    expect(registry.has("missing")).toBe(false);
    expect(registry.get("fast")).toBe(fast);
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.entries()).toEqual([
      ["fast", fast],
      ["safe", safe],
    ]);
  });

  it("does not expose mutable catalog state", () => {
    const registry = createRegistry("models", [["fast", fast]]);
    const entries = registry.entries();

    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.names)).toBe(true);
    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(entries[0])).toBe(true);
    expect(() => (registry.names as string[]).push("unsafe")).toThrow(TypeError);
    expect(() => (entries as [string, Implementation][]).push(["unsafe", safe])).toThrow(TypeError);
    expect(registry.names).toEqual(["fast"]);
    expect(registry.size).toBe(1);
  });

  it("rejects duplicate names at construction", () => {
    expect(() =>
      createRegistry("models", [
        ["fast", fast],
        ["fast", safe],
      ]),
    ).toThrow(
      expect.objectContaining<Partial<RegistryNameConflictError>>({
        code: "registry_name_conflict",
        registryName: "models",
        entryName: "fast",
      }),
    );
  });

  it("provides an explicit failure for required lookup", () => {
    const registry = createRegistry("models", [["fast", fast]]);

    expect(registry.require("fast")).toBe(fast);
    expect(() => registry.require("missing")).toThrow(
      expect.objectContaining<Partial<RegistryEntryMissingError>>({
        code: "registry_entry_missing",
        registryName: "models",
        entryName: "missing",
      }),
    );
  });

  it("keeps selection outside the registry", () => {
    const registry = createRegistry("models", [
      ["fast", fast],
      ["safe", safe],
    ]);
    const selected = registry.get("safe");

    expect(selected?.run()).toBe("safe");
    expect(registry.names).toEqual(["fast", "safe"]);
  });
});
