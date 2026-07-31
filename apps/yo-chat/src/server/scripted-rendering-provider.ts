import { resource, sleep, type Operation } from "effection";
import {
  installModelProvider,
  ModelProviderModelContext,
  type AssistantMessage,
  type Model,
  type ModelProviderDriver,
} from "@sweatpants/model-provider";
import type { StreamEvent as RuntimeStreamEvent } from "@sweatpants/model-provider";

type RuntimeContext = Parameters<ModelProviderDriver["stream"]>[0]["context"];

const scriptedRenderingModel: Model = {
  id: "scripted-rendering",
  name: "Scripted Rendering Fixtures",
  api: "scripted-rendering",
  provider: "scripted-e2e",
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 4096,
};

const markdownFixture = `# Rendering fixture

This paragraph has *italic text* and **bold text**.

- alpha item
- beta item
`;

const mathFixture = `# Math fixture

Inline math: $E = mc^2$.

Block math:

$$
\\int_0^1 x^2 dx = \\frac{1}{3}
$$
`;

const deltaFixture = "Delta chunk one. Delta chunk two. Delta chunk three.";

const mermaidFixture = `# Mermaid fixture

\`\`\`mermaid
graph TD
  A[Start] --> B[Render Markdown]
  B --> C[Done]
\`\`\`
`;

function textFromContent(content: RuntimeContext["messages"][number]["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) => (block.type === "text" || block.type === "thinking" ? block.text : ""))
    .join("");
}

function latestUserText(context: RuntimeContext): string {
  for (const message of [...context.messages].reverse()) {
    if (message.role === "user") {
      return textFromContent(message.content);
    }
  }
  return "";
}

function latestToolResultText(context: RuntimeContext): string | undefined {
  for (const message of [...context.messages].reverse()) {
    if (message.role === "toolResult") {
      return textFromContent(message.content);
    }
  }
  return undefined;
}

function fixtureFor(context: RuntimeContext): string {
  const prompt = latestUserText(context).toLowerCase();
  if (prompt.includes("delta arrival")) {
    return deltaFixture;
  }
  if (prompt.includes("mermaid")) {
    return mermaidFixture;
  }
  if (prompt.includes("math")) {
    return mathFixture;
  }
  if (prompt.includes("markdown")) {
    return markdownFixture;
  }
  return markdownFixture;
}

function chunks(text: string, size = 14): string[] {
  const result: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    result.push(text.slice(index, index + size));
  }
  return result;
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: {
      input: 1,
      output: chunks(text).length,
      total: chunks(text).length + 1,
    },
    stopReason: "stop",
  };
}

export function createScriptedRenderingModelProvider(): ModelProviderDriver {
  return {
    *stream(request) {
      const prompt = latestUserText(request.context).toLowerCase();
      const toolResult = latestToolResultText(request.context);
      if (prompt.includes("deterministic pick card") && !toolResult) {
        const toolCall = {
          id: "scripted-pick-card-call",
          type: "function" as const,
          function: { name: "pick_card", arguments: { count: 3 } },
        };
        const final: AssistantMessage = {
          role: "assistant",
          content: [{ type: "toolCall", toolCall }],
          usage: { input: 1, output: 1, total: 2 },
          stopReason: "toolUse",
        };
        return resource(function* (provide) {
          let emitted = false;
          yield* provide({
            *next(): Operation<IteratorResult<RuntimeStreamEvent, AssistantMessage>> {
              if (!emitted) {
                emitted = true;
                return {
                  done: false,
                  value: { type: "toolcall_end", contentIndex: 0, toolCall, partial: final },
                };
              }
              return { done: true, value: final };
            },
          });
        });
      }

      const text =
        prompt.includes("deterministic pick card") && toolResult
          ? `Thread reconstruction fixture complete. ${toolResult}`
          : fixtureFor(request.context);
      const final = assistantMessage(text);
      return resource(function* (provide) {
        let emitted = 0;
        const delayedDeltas = prompt.includes("delta arrival");
        const parts = delayedDeltas
          ? ["Delta chunk one. ", "Delta chunk two. ", "Delta chunk three."]
          : chunks(text);

        yield* provide({
          *next(): Operation<IteratorResult<RuntimeStreamEvent, AssistantMessage>> {
            if (emitted < parts.length) {
              if (delayedDeltas) {
                yield* sleep(250);
              }
              const delta = parts[emitted++]!;
              const partialText = text.slice(0, parts.slice(0, emitted).join("").length);
              return {
                done: false,
                value: {
                  type: "text_delta",
                  contentIndex: 0,
                  delta,
                  partial: assistantMessage(partialText),
                },
              };
            }

            return { done: true, value: final };
          },
        });
      });
    },
    *sample(): Operation<AssistantMessage> {
      return assistantMessage(markdownFixture);
    },
  };
}

export function* installScriptedRenderingModelProvider(): Operation<void> {
  yield* installModelProvider(createScriptedRenderingModelProvider());
  yield* ModelProviderModelContext.set(scriptedRenderingModel);
}
