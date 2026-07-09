/**
 * Durability Lab — product differentiator demos (Phase 2).
 *
 * Three scenarios, each runnable in under three minutes without Effection literacy:
 * 1. Reconnect mid-stream
 * 2. Elicit pause/resume
 * 3. MCP tool → browser elicit → MCP result
 */
import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/lab/durability/")({
  component: DurabilityLabPage,
});

function DurabilityLabPage() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <p className="text-sm uppercase tracking-widest text-cyan-400 mb-2">
          Product demos
        </p>
        <h1 className="text-4xl font-bold mb-3">Durability Lab</h1>
        <p className="text-slate-300 mb-8 text-lg">
          Production chat sessions that survive reconnect, tool pause/resume, and
          human-in-the-loop — correctly. Each demo is under three minutes.
        </p>

        <ol className="space-y-6 mb-12">
          <DemoCard
            number={1}
            title="Reconnect mid-stream"
            time="~2 min"
            path="/chat/basic"
            steps={[
              "Open Basic Chat and send a longer prompt (essay / multi-paragraph).",
              "While streaming, refresh the page or close the tab mid-response.",
              "Re-open the same route — the conversation id is stored in localStorage.",
              "Confirm the assistant message finishes without missing content from the disconnect.",
            ]}
            testGate="pnpm -C packages/framework exec vitest run acceptance/demo-reconnect-mid-stream.acceptance.test.ts"
          />

          <DemoCard
            number={2}
            title="Elicit pause/resume"
            time="~3 min"
            path="/chat/flight"
            steps={[
              "Open Flight Booking and ask to book a flight (e.g. Boston → NYC).",
              "When the flight picker appears, refresh or close the tab (leave the elicit unanswered).",
              "Return to the same conversation — the pending elicit should still be answerable.",
              "Pick a flight and finish the booking turn without a duplicate new elicit identity.",
            ]}
            testGate="pnpm -C packages/framework exec vitest run acceptance/demo-elicit-pause-resume.acceptance.test.ts"
          />

          <DemoCard
            number={3}
            title="MCP tool → browser elicit → MCP result"
            time="~3 min"
            path="/chat/cards"
            steps={[
              "Open Card Picker (browser elicit UI for an MCP-style plugin tool).",
              "Trigger pick_card so the tool waits on a human choice in the chat UI.",
              "Answer the picker — the in-flight tool call completes with a coherent result.",
              "Optional: decline/cancel paths also return structured terminal results (no hang).",
            ]}
            testGate="pnpm -C apps/yo-chat exec vitest run acceptance/demo-mcp-browser-elicit.acceptance.test.ts"
          />
        </ol>

        <section className="rounded-xl border border-slate-700 bg-slate-900/60 p-6 mb-8">
          <h2 className="text-xl font-semibold mb-2">What you do not need</h2>
          <ul className="list-disc list-inside text-slate-300 space-y-1">
            <li>No Effection generators in app code for these demos</li>
            <li>No Redis required (in-memory durable streams by default)</li>
            <li>No AgentCore required (local tool runtime by default)</li>
          </ul>
        </section>

        <section className="rounded-xl border border-slate-700 bg-slate-900/60 p-6">
          <h2 className="text-xl font-semibold mb-2">Docs</h2>
          <p className="text-slate-300 mb-3">
            Full write-ups live under{" "}
            <code className="text-cyan-300">docs/demos/</code> in the monorepo.
          </p>
          <ul className="list-disc list-inside text-slate-300 space-y-1">
            <li>
              <Link className="text-cyan-400 hover:underline" to="/chat/basic">
                Basic Chat
              </Link>{" "}
              — durable reconnect surface
            </li>
            <li>
              <Link className="text-cyan-400 hover:underline" to="/chat/flight">
                Flight Booking
              </Link>{" "}
              — multi-step elicit
            </li>
            <li>
              <Link className="text-cyan-400 hover:underline" to="/chat/cards">
                Card Picker
              </Link>{" "}
              — plugin elicit → tool result
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}

function DemoCard(props: {
  number: number;
  title: string;
  time: string;
  path: string;
  steps: string[];
  testGate: string;
}) {
  return (
    <li className="rounded-xl border border-slate-700 bg-slate-900 p-6">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <p className="text-cyan-400 text-sm font-medium">
            Demo {props.number} · {props.time}
          </p>
          <h2 className="text-2xl font-semibold">{props.title}</h2>
        </div>
        <Link
          to={props.path}
          className="shrink-0 rounded-lg bg-cyan-600 hover:bg-cyan-500 px-4 py-2 text-sm font-medium"
        >
          Open
        </Link>
      </div>
      <ol className="list-decimal list-inside space-y-1 text-slate-300 mb-4">
        {props.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="text-xs text-slate-500 font-mono break-all">{props.testGate}</p>
    </li>
  );
}
