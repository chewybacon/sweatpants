import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createTool } from "@sweatpants/agent-sdk";
import { createPluginRegistry, createPluginRegistryFrom } from "../plugin-registry.ts";
import { makePlugin, type ClientPluginRegistration } from "../plugin.ts";

function createMockPlugin(toolName: string, responseKey = "value"): ClientPluginRegistration {
  const tool = createTool(toolName)
    .description("test")
    .parameters(z.object({}))
    .elicits({ testKey: z.object({ [responseKey]: z.string() }) })
    .execute(function* () {
      return null;
    });
  return makePlugin(tool)
    .onElicit({
      testKey: function* () {
        return { action: "accept" as const, content: { [responseKey]: "test" } };
      },
    })
    .build().client;
}

describe("createPluginRegistry", () => {
  it("creates an empty registry", () => {
    const registry = createPluginRegistry();
    expect(registry.size).toBe(0);
    expect(registry.toolNames()).toEqual([]);
  });

  it("registers a plugin by exact binding identity", () => {
    const registry = createPluginRegistry();
    const plugin = createMockPlugin("test_tool");
    const bindingId = [...plugin.bindings.keys()][0]!;

    registry.register(plugin);

    expect(registry.size).toBe(1);
    expect(registry.has(bindingId)).toBe(true);
    expect(registry.get(bindingId)).toBe(plugin.bindings.get(bindingId));
  });

  it("registers multiple plugins", () => {
    const registry = createPluginRegistry();
    const plugin1 = createMockPlugin("tool_one");
    const plugin2 = createMockPlugin("tool_two");

    registry.register(plugin1);
    registry.register(plugin2);

    expect(registry.size).toBe(2);
    expect(registry.toolNames()).toEqual(["tool_one", "tool_two"]);
  });

  it("returns undefined for an unknown binding identity", () => {
    const registry = createPluginRegistry();
    registry.register(createMockPlugin("known_tool"));

    expect(registry.get("unknown_binding")).toBeUndefined();
    expect(registry.has("unknown_binding")).toBe(false);
  });

  it("allows same-named contracts with distinct exact interfaces", () => {
    const registry = createPluginRegistry();
    const first = createMockPlugin("same_name", "first");
    const second = createMockPlugin("same_name", "second");

    registry.register(first);
    registry.register(second);

    expect(registry.size).toBe(2);
    expect(registry.toolNames()).toEqual(["same_name"]);
  });
});

describe("createPluginRegistryFrom", () => {
  it("creates registry from an empty array", () => {
    expect(createPluginRegistryFrom([]).size).toBe(0);
  });

  it("creates registry from client registrations", () => {
    const registry = createPluginRegistryFrom([
      createMockPlugin("tool_a"),
      createMockPlugin("tool_b"),
      createMockPlugin("tool_c"),
    ]);

    expect(registry.size).toBe(3);
    expect(registry.toolNames()).toEqual(["tool_a", "tool_b", "tool_c"]);
  });
});
