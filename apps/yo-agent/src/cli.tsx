#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { call, main } from "effection";
import { createChatClient, type ChatFetch } from "@sweatpants/chat-client";
import { App } from "./components/App.tsx";
import { MouseProvider } from "./lib/MouseProvider.tsx";
import { useDevServer } from "./lib/dev-server.ts";
import { IN_PROCESS_BASE_URL } from "./lib/in-process-handler.ts";
import { terminalProcessors } from "./pipeline/index.ts";
import { askUserPlugin } from "./terminal/ask-user-plugin.ts";
import { TerminalInteractionRuntime } from "./terminal/interaction.ts";

await main(function* () {
  if (!process.stdin.isTTY) {
    console.error("yo-agent requires an interactive terminal.");
    return;
  }

  console.log("Starting the in-process host, model, tools, and terminal client...");
  const devServer = yield* useDevServer({
    root: process.cwd(),
    toolsPath: "./src/tools",
  });
  const chatFetch: ChatFetch = (input, init) =>
    devServer.fetch(input instanceof Request ? input : new Request(input, init));
  const interaction = new TerminalInteractionRuntime({ plugins: [askUserPlugin] });
  const client = createChatClient({
    threadId: `yo-agent-${crypto.randomUUID()}`,
    transport: {
      http: {
        api: `${IN_PROCESS_BASE_URL}/api/chat`,
        fetch: chatFetch,
      },
    },
    pipeline: { processors: terminalProcessors },
    interaction,
  });
  yield* call(() => client.initialized);

  const instance = render(
    <MouseProvider enabled={true}>
      <App client={client} interaction={interaction} />
    </MouseProvider>,
  );

  try {
    yield* call(() => instance.waitUntilExit());
  } finally {
    instance.unmount();
    yield* call(() => client.close());
  }
});
