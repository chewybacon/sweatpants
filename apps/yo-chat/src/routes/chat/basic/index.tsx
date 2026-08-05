import { createFileRoute } from "@tanstack/react-router";
import { ChatDemoShell } from "@/components/ChatDemoShell";

export const Route = createFileRoute("/chat/basic/")({
  component: BasicChatDemo,
});

function BasicChatDemo() {
  return (
    <ChatDemoShell
      definition={{
        namespace: "basic",
        label: "Basic Chat",
        pipeline: "full",
        plugins: [],
        suggestions: [
          { label: "Quantum computing", message: "Tell me about quantum computing" },
          { label: "Haiku about code", message: "Write a haiku about code" },
          { label: "React hooks", message: "Explain how React hooks work" },
        ],
      }}
    />
  );
}
