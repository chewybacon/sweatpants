import { createSignal } from "effection";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTool } from "@sweatpants/agent-sdk";
import { makePlugin } from "../plugin.ts";
import { createClientElicitDispatcher, type ClientElicitDiagnostic } from "../client-dispatcher.ts";

const contextSchema = z.object({ raw: z.string() }).transform(({ raw }) => ({
  normalized: raw.toUpperCase(),
}));
const tool = createTool("dispatcher_fixture")
  .description("dispatcher fixture")
  .parameters(z.object({}))
  .elicits({
    choose: {
      response: z.object({ value: z.string() }),
      context: contextSchema,
      contextProjections: {
        inputProjection: { type: "object" },
        outputProjection: { type: "object" },
      },
    },
  })
  .execute(function* () {
    return null;
  });

describe("client elicitation dispatcher", () => {
  it("validates direct context once and sends only terminal handler output", async () => {
    const calls: unknown[] = [];
    const plugin = makePlugin(tool)
      .onElicit({
        choose: function* (input, capabilities, metadata) {
          calls.push([input, capabilities, metadata]);
          return { action: "accept" as const, content: { value: input.context.normalized } };
        },
      })
      .build().client;
    const binding = [...plugin.bindings.values()][0]!;
    const completions: unknown[] = [];
    const registry = (await import("../plugin.ts")).createPluginRegistryFrom([plugin]);
    const dispatcher = createClientElicitDispatcher({
      registry,
      createCapabilities: (_request, _binding, signal) => ({ signal }),
      onCompletion: (_request, completion) => completions.push(completion),
    });
    dispatcher.observe({
      elicitId: "elicit-1",
      bindingId: binding.binding.id,
      toolName: tool.name,
      key: "choose",
      message: "Choose",
      callId: "call-1",
      seq: 0,
      context: { raw: "ok" },
      responseContract: binding.responseContract,
      /* CONDITIONAL-SPREAD: Omit absent contextContract from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
      ...(binding.contextContract ? { contextContract: binding.contextContract } : {}),
      placement: { nodeId: "elicit-1", parentNodeId: null, sequence: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);
    expect((calls[0] as [{ context: { normalized: string } }])[0].context).toEqual({
      normalized: "OK",
    });
    expect(completions).toEqual([{ action: "accept", content: { value: "OK" } }]);
    dispatcher.dispose();
  });

  it("keeps a malformed request parked and permits exact binding repair", async () => {
    const diagnostics: ClientElicitDiagnostic[] = [];
    const completions: unknown[] = [];
    const registry = (await import("../plugin.ts")).createPluginRegistry();
    const dispatcher = createClientElicitDispatcher({
      registry,
      createCapabilities: (_request, _binding, signal) => ({ signal }),
      onCompletion: (_request, completion) => completions.push(completion),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const plugin = makePlugin(tool)
      .onElicit({
        choose: function* () {
          return { action: "accept" as const, content: { value: "repaired" } };
        },
      })
      .build().client;
    const binding = [...plugin.bindings.values()][0]!;
    const request = {
      elicitId: "elicit-2",
      bindingId: binding.binding.id,
      toolName: tool.name,
      key: "choose",
      message: "Choose",
      callId: "call-2",
      seq: 0,
      context: { wrong: true },
      responseContract: binding.responseContract,
      /* CONDITIONAL-SPREAD: Omit absent contextContract from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
      ...(binding.contextContract ? { contextContract: binding.contextContract } : {}),
      placement: { nodeId: "elicit-2", parentNodeId: null, sequence: 0 },
    } as const;
    dispatcher.observe(request);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(diagnostics.at(-1)?.code).toBe("client_elicit_binding_missing");
    expect(completions).toHaveLength(0);
    registry.register(plugin);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(diagnostics.at(-1)?.code).toBe("client_elicit_context_invalid");
    expect(completions).toHaveLength(0);
    dispatcher.dispose();
  });

  it("distinguishes a same-name interface mismatch from a missing binding", async () => {
    const diagnostics: ClientElicitDiagnostic[] = [];
    const plugin = makePlugin(tool)
      .onElicit({
        choose: function* () {
          return { action: "cancel" as const };
        },
      })
      .build().client;
    const binding = [...plugin.bindings.values()][0]!;
    const registry = (await import("../plugin.ts")).createPluginRegistryFrom([plugin]);
    const dispatcher = createClientElicitDispatcher({
      registry,
      createCapabilities: (_request, _binding, signal) => ({ signal }),
      onCompletion: () => undefined,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    dispatcher.observe({
      elicitId: "mismatch-1",
      bindingId: "0".repeat(64),
      toolName: tool.name,
      key: "choose",
      message: "Choose",
      callId: "call-mismatch",
      seq: 0,
      context: { raw: "ok" },
      responseContract: binding.responseContract,
      /* CONDITIONAL-SPREAD: Omit absent contextContract from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
      ...(binding.contextContract ? { contextContract: binding.contextContract } : {}),
      placement: { nodeId: "mismatch-1", parentNodeId: null, sequence: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(diagnostics.at(-1)?.code).toBe("client_elicit_binding_mismatch");
    dispatcher.dispose();
  });

  it("does not start a second operation for duplicate delivery", async () => {
    let starts = 0;
    const plugin = makePlugin(tool)
      .onElicit({
        choose: function* () {
          starts += 1;
          return { action: "accept" as const, content: { value: "once" } };
        },
      })
      .build().client;
    const binding = [...plugin.bindings.values()][0]!;
    const registry = (await import("../plugin.ts")).createPluginRegistryFrom([plugin]);
    const dispatcher = createClientElicitDispatcher({
      registry,
      createCapabilities: (_request, _binding, signal) => ({ signal }),
      onCompletion: () => undefined,
    });
    const request = {
      elicitId: "elicit-3",
      bindingId: binding.binding.id,
      toolName: tool.name,
      key: "choose",
      message: "Choose",
      callId: "call-3",
      seq: 0,
      context: { raw: "ok" },
      responseContract: binding.responseContract,
      /* CONDITIONAL-SPREAD: Omit absent contextContract from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
      ...(binding.contextContract ? { contextContract: binding.contextContract } : {}),
      placement: { nodeId: "elicit-3", parentNodeId: null, sequence: 0 },
    };
    dispatcher.observe(request);
    dispatcher.observe(request);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toBe(1);
    dispatcher.dispose();
  });

  it("keeps an opaque handler failure local and does not send completion", async () => {
    const diagnostics: ClientElicitDiagnostic[] = [];
    const completions: unknown[] = [];
    const plugin = makePlugin(tool)
      .onElicit({
        choose: function* () {
          throw new Error("renderer failed");
        },
      })
      .build().client;
    const binding = [...plugin.bindings.values()][0]!;
    const registry = (await import("../plugin.ts")).createPluginRegistryFrom([plugin]);
    const dispatcher = createClientElicitDispatcher({
      registry,
      createCapabilities: (_request, _binding, signal) => ({ signal }),
      onCompletion: (_request, completion) => completions.push(completion),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    dispatcher.observe({
      elicitId: "failed-1",
      bindingId: binding.binding.id,
      toolName: tool.name,
      key: "choose",
      message: "Choose",
      callId: "call-failed",
      seq: 0,
      context: { raw: "ok" },
      responseContract: binding.responseContract,
      /* CONDITIONAL-SPREAD: Omit absent contextContract from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
      ...(binding.contextContract ? { contextContract: binding.contextContract } : {}),
      placement: { nodeId: "failed-1", parentNodeId: null, sequence: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(diagnostics.at(-1)?.code).toBe("client_elicit_handler_failed");
    expect(completions).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatcher.active("failed-1")).toBe(false);
    dispatcher.dispose();
  });

  it("propagates host cancellation through the capability signal", async () => {
    let signal: AbortSignal | undefined;
    const plugin = makePlugin(tool)
      .onElicit({
        choose: function* () {
          const wait = createSignal<void, void>();
          const subscription = yield* wait;
          yield* subscription.next();
          return { action: "cancel" as const };
        },
      })
      .build().client;
    const binding = [...plugin.bindings.values()][0]!;
    const registry = (await import("../plugin.ts")).createPluginRegistryFrom([plugin]);
    const dispatcher = createClientElicitDispatcher({
      registry,
      createCapabilities: (_request, _binding, nextSignal) => {
        signal = nextSignal;
        return { signal: nextSignal };
      },
      onCompletion: () => undefined,
    });
    const request = {
      elicitId: "elicit-4",
      bindingId: binding.binding.id,
      toolName: tool.name,
      key: "choose",
      message: "Choose",
      callId: "call-4",
      seq: 0,
      context: { raw: "ok" },
      responseContract: binding.responseContract,
      /* CONDITIONAL-SPREAD: Omit absent contextContract from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
      ...(binding.contextContract ? { contextContract: binding.contextContract } : {}),
      placement: { nodeId: "elicit-4", parentNodeId: null, sequence: 0 },
    };
    dispatcher.observe(request);
    await new Promise((resolve) => setTimeout(resolve, 0));
    dispatcher.cancel("elicit-4");
    expect(signal?.aborted).toBe(true);
    dispatcher.dispose();
  });
});
