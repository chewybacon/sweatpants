import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { act, fireEvent, render, within, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, it, onTestFinished } from "vitest";
import { createApplication } from "../../examples/chat-prototype/application.ts";
import { createBrowserChat } from "../../examples/chat-prototype/transport.ts";
import { createFlightFrontend } from "../../examples/chat-prototype/flight-frontend.tsx";
import { Chat, ChatProvider } from "../../examples/chat-prototype/ui.tsx";
import { completedSampling } from "../../examples/yo-chat-sampling.ts";
import { createSqliteDatabaseRig } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { ChatSampling } from "@sweatpan.ts/chat";
import type { ModelInfo } from "@sweatpan.ts/providers";
import { forEachRuntime } from "../runtime/assembly.ts";

const model: ModelInfo = {
  id: "local",
  provider: "test",
  api: "scripted",
  name: "Local",
  input: ["text"],
  output: ["text"],
  contextWindow: 8192,
  maxOutputTokens: 1024,
  reasoningLevels: [],
};
forEachRuntime(<Y,>(runtime: Runtime<Y>) => {
  for (const cleanup of [false, true]) {
    it(`${runtime.name}: code mode repairs syntax and reopens nested flight handlers (cleanup ${cleanup})`, async () => {
      const source = cleanup
        ? "return workflow.scope(function() return choose_flight({destination=42}) end, function() choose_flight(input) end)"
        : "return choose_flight(input)";
      const database = createSqliteDatabaseRig();
      const loadLuaModule = () =>
        readFile(
          resolve(
            import.meta.dirname,
            "../../../codemode-runtime-lua/generated/library-kernel.wasm",
          ),
        ).then((bytes) => WebAssembly.compile(bytes));
      let samples = 0;
      const sampling: ChatSampling<Y> = {
        *sample(request) {
          samples++;
          expect(request.tools.map((tool) => tool.name)).toEqual(["run_lua"]);
          expect(request.tools[0]!.description).toContain("choose_flight");
          const results = request.history.filter((message) => message.role === "tool");
          if (samples === 2) {
            expect(JSON.parse(String(results.at(-1)?.content)).status).toBe("invalid");
          }
          if (samples === 3) {
            expect(JSON.parse(String(results.at(-1)?.content)).status).toBe("valid");
          }
          if (samples === 4) {
            const result = results.at(-1);
            if (cleanup) {
              expect(JSON.parse(String(result?.content))).toMatchObject({ status: "failed" });
            } else {
              expect(JSON.parse(String(result?.content)).value).toMatchObject({
                demo: true,
                seat: "2B",
                flight: { id: "flight-2" },
              });
            }
          }
          return {
            ok: true,
            value: {
              model,
              response: {
                message: {
                  role: "assistant",
                  content:
                    samples <= 3
                      ? [
                          {
                            type: "tool-call",
                            toolCall: {
                              id: `code-call-${samples}`,
                              name: "run_lua",
                              input: {
                                source: samples === 1 ? "local =" : source,
                                input: { destination: "LAX" },
                                validateOnly: samples === 2,
                              },
                              thoughtSignature: null,
                            },
                          },
                        ]
                      : [
                          {
                            type: "text",
                            text: "Your demo selection is saved. No booking was made.",
                          },
                        ],
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
      };
      let app = createApplication(runtime, database.database, {
        sampling: completedSampling(runtime, sampling),
        loadLuaModule,
      });
      let dropBefore = true;
      let dropAfter = true;
      const answers: string[] = [];
      const send: typeof fetch = async (input, init) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname.endsWith("/answers")) {
          answers.push(String(init?.body));
          if (dropBefore) {
            dropBefore = false;
            throw new Error("Disconnected before delivery");
          }
        }
        const response = await app.fetch(new Request(url, init));
        if (
          url.pathname.endsWith("/answers") &&
          String(init?.body).includes('"kind":"pickSeat"') &&
          dropAfter &&
          response.ok
        ) {
          dropAfter = false;
          throw new Error("Receipt lost after acceptance");
        }
        return response;
      };
      let client = createBrowserChat(send);
      let frontend = createFlightFrontend(runtime, client);
      function mount() {
        return render(
          <StrictMode>
            <ChatProvider client={client} frontend={frontend}>
              <Chat />
            </ChatProvider>
          </StrictMode>,
        );
      }
      let ui = mount();
      onTestFinished(async () => {
        ui.unmount();
        await frontend.disconnect();
        await client.disconnect();
        client.close();
        await app.close();
        database.close();
      });
      await act(async () => {
        frontend.connect();
        client.connect();
        await client.refresh();
      });
      expect(client.getSnapshot().error).toBeUndefined();
      fireEvent.change(within(ui.container).getByLabelText("Message"), {
        target: { value: "Help me pick a flight to LAX" },
      });
      fireEvent.click(within(ui.container).getByLabelText("Use code mode"));
      fireEvent.click(within(ui.container).getByRole("button", { name: "Send" }));
      await waitFor(() => {
        expect(client.getSnapshot().error).toBeUndefined();
        expect(client.getSnapshot().view?.questions).toHaveLength(1);
      });
      await within(ui.container).findByRole("button", { name: /Choose CloudAir/ });
      expect(samples).toBe(3);
      const question = client.getSnapshot().view!.questions[0]!;
      expect(question.parentExecution).toBeTruthy();
      expect(within(ui.container).getAllByRole("region", { name: "Lua program" })).toHaveLength(3);
      const currentProgram = within(ui.container)
        .getAllByRole("region", { name: "Lua program" })
        .at(-1)!;
      expect(within(currentProgram).getByRole("button", { name: /Choose CloudAir/ })).toBeTruthy();
      // Repeated full snapshots don't create another active picker.
      await act(async () => {
        await client.refresh();
        await client.refresh();
      });
      expect(within(ui.container).getAllByRole("button", { name: /Choose CloudAir/ })).toHaveLength(
        1,
      );
      await act(async () => {
        await frontend.disconnect();
        await client.disconnect();
      });
      ui.unmount();
      client.close();
      await app.close();
      database.reopen();
      app = createApplication(runtime, database.database, {
        sampling: completedSampling(runtime, sampling),
        loadLuaModule,
      });
      client = createBrowserChat(send);
      frontend = createFlightFrontend(runtime, client);
      ui = mount();
      await act(async () => {
        frontend.connect();
        client.connect();
        await client.refresh();
      });
      await within(ui.container).findByRole("button", { name: /Choose CloudAir/ });
      expect(client.getSnapshot().view!.questions[0]).toEqual(question);
      expect(samples).toBe(3);
      fireEvent.click(within(ui.container).getByRole("button", { name: /Choose CloudAir/ }));
      await within(ui.container).findByRole("button", { name: "Retry same answer" });
      expect(client.getSnapshot().view!.questions).toHaveLength(1);
      fireEvent.click(within(ui.container).getByRole("button", { name: "Retry same answer" }));
      await within(ui.container).findByRole("button", { name: "Seat 2B" });
      expect(answers[0]).toBe(answers[1]);
      expect(samples).toBe(3);
      fireEvent.click(within(ui.container).getByRole("button", { name: "Seat 2B" }));
      if (!cleanup) {
        await within(ui.container).findByText("Demo selection saved");
        expect(within(ui.container).getByText(/CloudAir to LAX.*Seat 2B/)).toBeTruthy();
      }
      await waitFor(() => expect(client.getSnapshot().view!.status).toBe("completed"));
      expect(samples).toBe(4);
      expect(client.getSnapshot().view!.questions).toEqual([]);
      expect(within(ui.container).queryByRole("button", { name: "Retry same answer" })).toBeNull();
      await act(async () => {
        await client.refresh();
      });
      expect(samples).toBe(4);
    });
  }
});
