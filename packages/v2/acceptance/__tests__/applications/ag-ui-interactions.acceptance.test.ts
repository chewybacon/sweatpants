import { EventType } from "@ag-ui/core";
import { EventSchemas } from "@ag-ui/core/schemas";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { createCardChatHandlers } from "../../../../../apps/yo-chat-v2/src/server/card-chat-handlers.ts";
import { chatView, type ChatCommand } from "../../../../../apps/yo-chat-v2/src/chat/contract.ts";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime((runtime) => {
  it(`${runtime.name}: AG-UI interrupts reconstruct all pending questions and disappear after durable answers`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "ag-ui-interactions-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    let samples = 0;
    const handlers = createCardChatHandlers(
      runtime,
      () => new DatabaseSync(join(directory, "chat.sqlite")),
      async () => ({
        *sample(request) {
          samples++;
          return {
            ok: true,
            value: {
              model: { id: "scripted", api: "scripted", provider: "scripted" },
              response: {
                message: {
                  role: "assistant",
                  content: request.history.some((entry) => entry.role === "tool")
                    ? [{ type: "text", text: "Both selections accepted" }]
                    : ["first", "second"].map((id) => ({
                        type: "tool-call" as const,
                        toolCall: {
                          id,
                          name: "pick_card",
                          input: { count: 1 },
                          thoughtSignature: null,
                        },
                      })),
                },
                source: null,
                usage: null,
                stopReason: null,
                responseId: null,
                errorMessage: null,
              },
            },
          };
        },
      }),
    );
    async function read(command?: ChatCommand) {
      const context = {
        request: new Request(
          "http://localhost/api/card-chat/interrupts",
          command
            ? {
                method: "POST",
                body: JSON.stringify(command),
              }
            : undefined,
        ),
        params: { thread: "interrupts" },
      };
      const response = await (command ? handlers.POST(context) : handlers.GET(context));
      const events = (await response.text())
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => EventSchemas.parse(JSON.parse(frame.slice(6))));
      return {
        terminal: events.at(-1),
        view: chatView.parse(events.find((event) => event.type === EventType.CUSTOM)?.value),
      };
    }
    const initial = await read({
      type: "message",
      command: crypto.randomUUID(),
      prompt: "Pick two cards",
      after: null,
    });
    const questions = initial.view.turns.flatMap((turn) =>
      turn.parts.flatMap((part) => (part.type === "tool" ? part.questions : [])),
    );
    expect(questions).toHaveLength(2);
    const expected = questions.map((question) => ({
      id: question.id,
      reason: "input_required",
      metadata: { "sweatpants/question": question },
    }));
    expect(initial.terminal).toMatchObject({
      outcome: { type: "interrupt", interrupts: expected },
    });
    const reopened = await read();
    expect(reopened.terminal).toMatchObject({
      outcome: { type: "interrupt", interrupts: expected },
    });
    expect(samples).toBe(1);
    for (const [index, question] of questions.entries()) {
      const input = question.input as { cards: unknown[] };
      const answered = await read({
        type: "answer",
        root: question.root,
        execution: question.execution,
        grant: question.grant!,
        value: input.cards[0],
      });
      if (index === 0) {
        expect(answered.terminal).toMatchObject({
          outcome: { type: "interrupt", interrupts: [expected[1]] },
        });
        const terminal = answered.terminal;
        if (terminal?.type === EventType.RUN_FINISHED && terminal.outcome?.type === "interrupt") {
          expect(terminal.outcome.interrupts).toHaveLength(1);
        }
      } else {
        expect(answered.terminal?.type).toBe("RUN_FINISHED");
        expect(answered.terminal).not.toHaveProperty("outcome");
        expect(answered.view.turns[0]?.status).toBe("completed");
      }
    }
    const completed = await read();
    expect(completed.terminal).not.toHaveProperty("outcome");
    expect(samples).toBe(2);
  });
});
