import { useEffect, useState } from "react";
import { Badge, Button, Card, Heading, HStack, Theme, VStack } from "@astryxdesign/core";
import { neutralTheme } from "@astryxdesign/theme-neutral";

type Scenario = "round" | "replay" | "guard";
type Step = {
  title: string;
  detail: string;
  code: string;
  active: string[];
  status: string;
  model: number;
  durable: string[];
  failed?: boolean;
};

const scenarios: Record<Scenario, { label: string; steps: Step[] }> = {
  round: {
    label: "One loop round",
    steps: [
      {
        title: "The browser sends a task",
        detail:
          "The ingress Worker routes the request to the conversation Durable Object. It does not evaluate Tisyn.",
        code: "task → Worker → Conversations DO",
        active: ["browser", "worker", "host"],
        status: "Routing",
        model: 0,
        durable: [],
      },
      {
        title: "The model authors once",
        detail:
          "Haiku returns Tisyn source. Sweatpants parses, validates, and accepts one recursive program. It will not call the model between replies.",
        code: "source → parse → validate → JSON IR",
        active: ["host", "model"],
        status: "Authoring",
        model: 1,
        durable: ["Accepted source + profile"],
      },
      {
        title: "QuickJS evaluates to a descriptor",
        detail:
          "A temporary QuickJS context runs the unchanged published Tisyn kernel. It yields an ask descriptor as JSON.",
        code: "JSON IR → QuickJS kernel → ask descriptor",
        active: ["host", "vm"],
        status: "At a yield",
        model: 1,
        durable: ["Accepted source + profile"],
      },
      {
        title: "Sweatpants runs the child",
        detail:
          "Sweatpants validates and dispatches ask outside the VM. The VM never calls tools directly.",
        code: "descriptor → Sweatpants → durable ask child",
        active: ["host", "tools"],
        status: "Child running",
        model: 1,
        durable: ["Accepted source + profile", "Pending ask #1"],
      },
      {
        title: "The workflow parks",
        detail:
          "The VM is disposed while a human waits. The pending interaction and its identity remain durable. Waiting uses no compute budget.",
        code: "VM disposed · pending ask retained",
        active: ["host", "journal", "streams", "browser"],
        status: "Waiting",
        model: 1,
        durable: ["Accepted source + profile", "Pending ask #1"],
      },
      {
        title: "Reply, replay, continue",
        detail:
          "After “hello”, a fresh evaluator replays accepted outcomes, reaches echo, and dispatches the next child. This is still one authored program.",
        code: "reply → replay → echo → next ask",
        active: ["host", "vm", "tools", "journal"],
        status: "Recovered",
        model: 1,
        durable: ["Accepted reply: hello", "Accepted echo: hello"],
      },
    ],
  },
  replay: {
    label: "Park & recover",
    steps: [
      {
        title: "Compute is replaced",
        detail:
          "Host and evaluator memory can disappear. The journal still has accepted source, outcomes, and the pending interaction.",
        code: "lose: VM + host memory · keep: journal",
        active: ["journal"],
        status: "Compute replaced",
        model: 1,
        durable: ["Source + profile", "Echo #1 accepted", "Pending ask #2"],
      },
      {
        title: "The browser reconnects",
        detail:
          "The same thread and pending ask come back. No model authoring call is needed to read history.",
        code: "same thread · same pending interaction",
        active: ["browser", "worker", "host", "streams", "journal"],
        status: "Reconnected",
        model: 1,
        durable: ["Source + profile", "Echo #1 accepted", "Pending ask #2"],
      },
      {
        title: "Replay skips accepted effects",
        detail:
          "The new evaluator consumes recorded ask and echo outcomes. It does not invoke echo #1 again.",
        code: "recorded outcome → kernel · no duplicate child",
        active: ["host", "vm", "journal"],
        status: "Replaying",
        model: 1,
        durable: ["Source + profile", "Echo #1 accepted", "Reply #2 accepted"],
      },
      {
        title: "Only new work runs",
        detail:
          "When replay reaches the next unaccepted effect, Sweatpants dispatches it and records the result. Durable truth stays outside the VM.",
        code: "next unaccepted descriptor → child",
        active: ["host", "vm", "tools", "journal"],
        status: "New effect",
        model: 1,
        durable: ["Reply #2 accepted", "Echo #2 accepted"],
      },
    ],
  },
  guard: {
    label: "Stop runaway code",
    steps: [
      {
        title: "A program never yields",
        detail:
          "While(true, []) is admitted as a shape, but it never returns and never requests a tool. Placement alone cannot bound synchronous work.",
        code: "While(true, [])",
        active: ["host", "vm"],
        status: "Computing",
        model: 1,
        durable: ["Accepted source + profile"],
      },
      {
        title: "QuickJS interrupts it",
        detail:
          "The engine invokes an interrupt handler while executing. This does not depend on a timer callback or the Workers clock advancing.",
        code: "256 interrupt checks per advance",
        active: ["vm"],
        status: "Budget exceeded",
        model: 1,
        durable: ["Accepted source + profile"],
        failed: true,
      },
      {
        title: "Failure is explicit",
        detail:
          "Sweatpants receives a coded evaluation failure. No child ran, no fake success is produced, and no model fallback replaces the program.",
        code: "tisyn_evaluation_failed",
        active: ["vm", "host", "journal"],
        status: "Failed + disposed",
        model: 1,
        durable: ["Workflow failed: compute limit"],
        failed: true,
      },
    ],
  },
};

const components: Record<string, [string, string]> = {
  browser: [
    "Browser",
    "Sends tasks and typed replies. It displays durable updates but never runs the Tisyn evaluator.",
  ],
  worker: [
    "Ingress Worker",
    "Routes HTTP requests. It is intentionally thin and is not the place where synchronous Tisyn computation runs.",
  ],
  model: [
    "Model provider",
    "Authors one Tisyn program and later summarizes the result. It is not called between loop rounds.",
  ],
  host: [
    "Conversations Durable Object",
    "Sweatpants owns scheduling, child tools, accepted outcomes, parking, and recovery here.",
  ],
  vm: [
    "QuickJS / WASM",
    "A temporary JavaScript engine for the published Tisyn kernel. It receives JSON IR and yields JSON descriptors. It does not own tools or the journal.",
  ],
  tools: [
    "Tool executor DO",
    "The native ask and echo children run outside QuickJS through the existing durable tool adapter.",
  ],
  journal: [
    "D1 journal",
    "The durable authority. Accepted source, pending work, and outcomes survive compute replacement.",
  ],
  streams: [
    "Response stream DO",
    "Delivers replayable UI updates. It is delivery infrastructure, not a second execution authority.",
  ],
};

export function QuickJsExplainer() {
  const [scenario, setScenario] = useState<Scenario>("round");
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState("vm");
  const current = scenarios[scenario].steps[index];
  useEffect(() => {
    if (!playing) {
      return;
    }
    const timer = window.setTimeout(() => {
      if (index >= scenarios[scenario].steps.length - 1) {
        setPlaying(false);
      } else {
        setIndex(index + 1);
      }
    }, 4200);
    return () => window.clearTimeout(timer);
  }, [playing, index, scenario]);
  const [inspectTitle, inspectCopy] = components[selected];
  return (
    <Theme theme={neutralTheme}>
      <VStack gap={5} className="explainer-island">
        <HStack hAlign="between" vAlign="end" gap={4} wrap="wrap">
          <VStack gap={2}>
            <Badge label="VISUAL EXPLANATION" variant="purple" />
            <Heading level={1} type="display-2">
              Durable work. Disposable computation.
            </Heading>
            <p>QuickJS bounds the kernel. Sweatpants remembers and acts.</p>
          </VStack>
          <a className="astryx-link" href="/playground">
            Back to playground →
          </a>
        </HStack>
        <HStack gap={2} wrap="wrap" className="scenario-tabs">
          {(Object.entries(scenarios) as [Scenario, (typeof scenarios)[Scenario]][]).map(
            ([key, value]) => (
              <Button
                key={key}
                label={value.label}
                variant={scenario === key ? "primary" : "secondary"}
                onClick={() => {
                  setScenario(key);
                  setIndex(0);
                  setPlaying(false);
                }}
              />
            ),
          )}
        </HStack>
        <div className="explainer-grid">
          <Card className="architecture-card" padding={3}>
            <div className="diagram-toolbar">
              <span>Illustration · not a live trace</span>
              <HStack gap={2}>
                <Button
                  label={playing ? "Pause" : "Play"}
                  size="sm"
                  variant="primary"
                  onClick={() => setPlaying(!playing)}
                />
                <Button
                  label="Back"
                  size="sm"
                  variant="ghost"
                  isDisabled={index === 0}
                  onClick={() => {
                    setPlaying(false);
                    setIndex(index - 1);
                  }}
                />
                <Button
                  label="Next"
                  size="sm"
                  variant="secondary"
                  isDisabled={index === scenarios[scenario].steps.length - 1}
                  onClick={() => {
                    setPlaying(false);
                    setIndex(index + 1);
                  }}
                />
              </HStack>
            </div>
            <svg
              className="architecture-svg"
              viewBox="0 0 920 520"
              role="img"
              aria-label="Browser, Worker, Conversations Durable Object, QuickJS, tools, journal, and response streams"
            >
              <defs>
                <marker
                  id="explainer-arrow"
                  markerWidth="8"
                  markerHeight="8"
                  refX="7"
                  refY="4"
                  orient="auto"
                >
                  <path d="M0 0 L8 4 L0 8Z" fill="currentColor" />
                </marker>
              </defs>
              <path
                className="diagram-edge"
                d="M150 170H250M380 170H475M620 170H730M530 260V350M730 260V350M380 260V430"
                markerEnd="url(#explainer-arrow)"
              />
              <path
                className="diagram-edge reverse"
                d="M730 390H620M475 390H380M250 450H150"
                markerEnd="url(#explainer-arrow)"
              />
              {([
                ["browser", 38, 125, "Browser", "reply / display"],
                ["worker", 250, 125, "Ingress Worker", "route only"],
                ["model", 475, 125, "Model", "author once"],
                ["host", 250, 350, "Sweatpants", "schedule · park · recover"],
                ["vm", 475, 350, "QuickJS / WASM", "bounded kernel"],
                ["tools", 730, 350, "ask / echo", "native children"],
                ["journal", 250, 430, "D1 journal", "durable truth"],
                ["streams", 38, 430, "ResponseStream", "UI delivery"],
              ] as [string, number, number, string, string][]).map(([name, x, y, title, subtitle]) => (
                <g
                  key={name}
                  className={`diagram-node ${current.active.includes(name) ? "active" : ""} ${current.failed && name === "vm" ? "failed" : ""} ${selected === name ? "selected" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelected(name)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      setSelected(name);
                    }
                  }}
                >
                  <rect x={Number(x)} y={Number(y)} width="150" height="70" rx="10" />
                  <text x={Number(x) + 13} y={Number(y) + 28}>
                    {title}
                  </text>
                  <text className="node-subtitle" x={Number(x) + 13} y={Number(y) + 50}>
                    {subtitle}
                  </text>
                </g>
              ))}
            </svg>
            <div className="diagram-step">
              <Badge
                label={`${index + 1} / ${scenarios[scenario].steps.length}`}
                variant={current.failed ? "error" : "teal"}
              />
              <strong>{current.status}</strong>
              <span>{current.code}</span>
            </div>
          </Card>
          <VStack gap={3}>
            <Card className="explanation-card" padding={5}>
              <Badge
                label={`${index + 1} / ${scenarios[scenario].steps.length} · ${scenarios[scenario].label}`}
                variant={current.failed ? "error" : "teal"}
              />
              <Heading level={2}>{current.title}</Heading>
              <p>{current.detail}</p>
              <pre>{current.code}</pre>
              <div className="metric-row">
                <span>Model calls</span>
                <strong>{current.model}</strong>
                <span>VM</span>
                <strong>{current.status}</strong>
              </div>
            </Card>
            <Card className="journal-card" variant="muted" padding={4}>
              <Heading level={3}>What survives</Heading>
              {current.durable.length ? (
                <ul>
                  {current.durable.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : (
                <p>Nothing accepted yet.</p>
              )}
            </Card>
            <Card className="inspector-card" padding={4}>
              <Badge label="SELECTED COMPONENT" variant="purple" />
              <Heading level={3}>{inspectTitle}</Heading>
              <p>{inspectCopy}</p>
            </Card>
          </VStack>
        </div>
        <div className="limit-strip">
          <Card padding={3}>
            <strong>256 checks</strong>
            <span>QuickJS interrupts per advance</span>
          </Card>
          <Card padding={3}>
            <strong>32 MiB</strong>
            <span>VM allocation limit</span>
          </Card>
          <Card padding={3}>
            <strong>64 KiB</strong>
            <span>VM stack limit</span>
          </Card>
          <Card padding={3}>
            <strong>256 calls</strong>
            <span>Tool-call adapter limit</span>
          </Card>
        </div>
      </VStack>
    </Theme>
  );
}
