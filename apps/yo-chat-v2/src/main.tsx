import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserChat } from "./transport.ts";
import { ChatProvider, Chat } from "./ui.tsx";
import "./style.css";
const client = createBrowserChat();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ChatProvider client={client}>
      <Chat />
    </ChatProvider>
  </StrictMode>,
);
void client.refresh().catch(() => undefined);
