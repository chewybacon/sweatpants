import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserChat } from "./transport.ts";
import { ChatProvider, Chat } from "./ui.tsx";
import "./style.css";
import { createRuntime } from "@sweatpan.ts/runtime-effection";
import { createFlightFrontend } from "./flight-frontend.tsx";
const client = createBrowserChat();
const frontend = createFlightFrontend(createRuntime(), client);
frontend.connect();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ChatProvider client={client} frontend={frontend}>
      <Chat />
    </ChatProvider>
  </StrictMode>,
);
client.connect();
window.addEventListener("pagehide", () => {
  void frontend.disconnect();
  void client.disconnect();
});
window.addEventListener("pageshow", () => {
  frontend.connect();
  client.connect();
});
