import { createFileRoute } from "@tanstack/react-router";
import "katex/dist/katex.min.css";
import { ChatDemoShell } from "@/components/ChatDemoShell";

export const Route = createFileRoute("/chat/math/")({
  component: MathAssistantDemo,
});

function MathAssistantDemo() {
  return (
    <ChatDemoShell
      definition={{
        namespace: "math",
        label: "Math Assistant",
        pipeline: "math",
        plugins: [],
        suggestions: [
          { label: "sqrt(12345) * pi", message: "Calculate sqrt(12345) * pi" },
          { label: "Solve 2x + 5 = 15", message: "Solve 2x + 5 = 15. Show your work." },
          { label: "Integral of x^2", message: "What is the integral of x^2 from 0 to 1?" },
        ],
      }}
    />
  );
}
