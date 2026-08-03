import { describe, expect, it } from "vitest";
import type { ChatInteractionCompletion, ChatInteractionRequest } from "@sweatpants/chat-client";
import { askUserPlugin } from "./ask-user-plugin.ts";
import { TerminalInteractionRuntime } from "./interaction.ts";

function request(elicitId: string): ChatInteractionRequest {
  const binding = [...askUserPlugin.client.bindings.values()][0]!;
  return {
    elicitId,
    bindingId: binding.bindingId,
    toolName: binding.toolName,
    key: binding.key,
    message: "Which branch should I inspect?",
    callId: "call-1",
    seq: 0,
    context: { question: "Which branch should I inspect?" },
    responseContract: binding.responseContract,
    ...(binding.contextContract ? { contextContract: binding.contextContract } : {}),
    placement: {
      nodeId: `elicit:${elicitId}`,
      parentNodeId: "execution:call-1",
      sequence: 0,
    },
  };
}

function completion(runtime: TerminalInteractionRuntime): Promise<ChatInteractionCompletion> {
  return new Promise((resolve) => {
    runtime.setOnCompletion((_request, result) => resolve(result));
  });
}

describe("TerminalInteractionRuntime", () => {
  it("projects one prompt and returns typed accepted content", async () => {
    const runtime = new TerminalInteractionRuntime({ plugins: [askUserPlugin] });
    const completed = completion(runtime);
    const observed = request("answer-1");

    runtime.observe(observed);
    runtime.observe(observed);
    expect(runtime.localParts().get(observed.elicitId)).toHaveLength(1);
    expect(runtime.activePrompt).toMatchObject({
      type: "terminal-prompt",
      message: "Which branch should I inspect?",
      state: "pending",
    });

    runtime.respond("main");
    await expect(completed).resolves.toEqual({
      action: "accept",
      content: { answer: "main" },
    });
    expect(runtime.activePrompt).toBeNull();
    expect(runtime.localParts().get(observed.elicitId)?.[0]).toMatchObject({
      state: "completed",
      response: "main",
    });

    runtime.settled(observed.elicitId);
    expect(runtime.localParts().has(observed.elicitId)).toBe(false);
    runtime.dispose();
  });

  it.each(["decline", "cancel"] as const)("propagates %s distinctly", async (action) => {
    const runtime = new TerminalInteractionRuntime({ plugins: [askUserPlugin] });
    const completed = completion(runtime);
    const observed = request(`answer-${action}`);
    runtime.observe(observed);

    if (action === "decline") {
      runtime.decline();
    } else {
      runtime.cancelActive();
    }

    await expect(completed).resolves.toEqual({ action });
    runtime.settled(observed.elicitId);
    runtime.dispose();
  });

  it("disposes a pending prompt", () => {
    const runtime = new TerminalInteractionRuntime({ plugins: [askUserPlugin] });
    runtime.observe(request("answer-dispose"));
    expect(runtime.activePrompt).not.toBeNull();

    runtime.dispose();

    expect(runtime.activePrompt).toBeNull();
    expect(runtime.localParts().size).toBe(0);
  });
});
