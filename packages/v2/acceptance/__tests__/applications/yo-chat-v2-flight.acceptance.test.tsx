import { act, fireEvent, render, within, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, it, onTestFinished } from "vitest";
import { createApplication } from "../../../../../apps/yo-chat-v2/src/application.ts";
import { createBrowserChat } from "../../../../../apps/yo-chat-v2/src/transport.ts";
import { createFlightFrontend } from "../../../../../apps/yo-chat-v2/src/flight-frontend.tsx";
import { Chat, ChatProvider } from "../../../../../apps/yo-chat-v2/src/ui.tsx";
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
  it(`${runtime.name}: browser flight handlers reopen, retry identical answers and show accepted selections`, async () => {
    const database = createSqliteDatabaseRig();
    let samples = 0;
    const sampling: ChatSampling<Y> = {
      *sample(request) {
        samples++;
        expect(request.tools.map((tool) => tool.name)).toEqual(["choose_flight"]);
        if (samples === 2) {
          const result = request.history.find((message) => message.role === "tool");
          expect(JSON.parse(String(result?.content))).toMatchObject({
            demo: true,
            seat: "2B",
            flight: { id: "flight-2" },
          });
        }
        return {
          ok: true,
          value: {
            model,
            response: {
              message: {
                role: "assistant",
                content:
                  samples === 1
                    ? [
                        {
                          type: "tool-call",
                          toolCall: {
                            id: "flight-call",
                            name: "choose_flight",
                            input: { destination: "LAX" },
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
    fireEvent.change(within(ui.container).getByLabelText("Message"), {
      target: { value: "Help me pick a flight to LAX" },
    });
    fireEvent.click(within(ui.container).getByRole("button", { name: "Send" }));
    await within(ui.container).findByRole("button", { name: /Choose CloudAir/ });
    expect(samples).toBe(1);
    const question = client.getSnapshot().view!.questions[0]!;
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
    expect(samples).toBe(1);
    fireEvent.click(within(ui.container).getByRole("button", { name: /Choose CloudAir/ }));
    await within(ui.container).findByRole("button", { name: "Retry same answer" });
    expect(client.getSnapshot().view!.questions).toHaveLength(1);
    fireEvent.click(within(ui.container).getByRole("button", { name: "Retry same answer" }));
    await within(ui.container).findByRole("button", { name: "Seat 2B" });
    expect(answers[0]).toBe(answers[1]);
    expect(samples).toBe(1);
    fireEvent.click(within(ui.container).getByRole("button", { name: "Seat 2B" }));
    await within(ui.container).findByText("Demo selection saved");
    expect(within(ui.container).getByText(/CloudAir to LAX.*Seat 2B/)).toBeTruthy();
    await waitFor(() => expect(client.getSnapshot().view!.status).toBe("completed"));
    expect(samples).toBe(2);
    expect(client.getSnapshot().view!.questions).toEqual([]);
    expect(within(ui.container).queryByRole("button", { name: "Retry same answer" })).toBeNull();
    await act(async () => {
      await client.refresh();
    });
    expect(samples).toBe(2);
  });
});
