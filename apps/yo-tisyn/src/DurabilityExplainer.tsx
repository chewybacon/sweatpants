import { useState } from "react";
import { Badge, Button, Card, Heading, HStack, Theme, VStack } from "@astryxdesign/core";
import { neutralTheme } from "@astryxdesign/theme-neutral";

const steps = [
  {
    label: "Accept",
    title: "One program becomes durable state",
    detail:
      "The model authors one typed Tisyn program. Sweatpants validates it and records the accepted source before the program starts.",
    survives: ["source", "model profile", "thread identity"],
    active: "author",
  },
  {
    label: "Run",
    title: "The host executes the next effect",
    detail:
      "QuickJS evaluates only bounded computation. Sweatpants owns the ask and echo children, their identity, and their results.",
    survives: ["accepted source", "pending child", "journal position"],
    active: "execute",
  },
  {
    label: "Park",
    title: "Waiting releases compute",
    detail:
      "A reply can take minutes or days. The VM and host memory can disappear. The pending interaction remains in the journal.",
    survives: ["accepted source", "pending ask", "response stream"],
    active: "park",
  },
  {
    label: "Recover",
    title: "A fresh host replays the truth",
    detail:
      "The next host reads accepted outcomes, skips completed effects, and runs only the first unaccepted effect. It does not ask the model to recreate the program.",
    survives: ["accepted outcomes", "new host", "same thread"],
    active: "recover",
  },
];

export function DurabilityExplainer() {
  const [index, setIndex] = useState(0);
  const current = steps[index];
  return (
    <Theme theme={neutralTheme}>
      <VStack gap={5} className="explainer-island durability-explainer">
        <HStack hAlign="between" vAlign="end" gap={4} wrap="wrap">
          <VStack gap={2}>
            <Badge label="DURABILITY EXPLAINED" variant="teal" />
            <Heading level={1} type="display-2">
              The journal is the memory.
            </Heading>
            <p>Hosts come and go. Accepted work does not.</p>
          </VStack>
          <a className="astryx-link" href="/playground">
            Back to playground →
          </a>
        </HStack>

        <Card className="durability-card" padding={4}>
          <HStack hAlign="between" vAlign="center" gap={3} wrap="wrap">
            <div>
              <span className="eyebrow">{index + 1} / {steps.length} · {current.label}</span>
              <Heading level={2}>{current.title}</Heading>
            </div>
            <HStack gap={2}>
              <Button
                label="Back"
                variant="ghost"
                isDisabled={index === 0}
                onClick={() => setIndex((value) => value - 1)}
              />
              <Button
                label="Next"
                variant="primary"
                isDisabled={index === steps.length - 1}
                onClick={() => setIndex((value) => value + 1)}
              />
            </HStack>
          </HStack>
          <p className="durability-detail">{current.detail}</p>
          <div className="durability-timeline" aria-label="Durable workflow lifecycle">
            {steps.map((step, stepIndex) => (
              <div className="durability-stage" key={step.active}>
                <button
                  className={`durability-node ${stepIndex === index ? "active" : ""}`}
                  type="button"
                  aria-label={step.label}
                  aria-current={stepIndex === index ? "step" : undefined}
                  onClick={() => setIndex(stepIndex)}
                >
                  <strong>{stepIndex + 1}</strong>
                  <span>{step.label}</span>
                </button>
                {stepIndex < steps.length - 1 && <span className="durability-arrow" aria-hidden="true">→</span>}
              </div>
            ))}
          </div>
        </Card>

        <div className="durability-grid">
          <Card padding={4}>
            <Badge label="WHAT SURVIVES" variant="purple" />
            <Heading level={2}>A small durable record</Heading>
            <ul className="durability-list">
              {current.survives.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </Card>
          <Card padding={4} variant="muted">
            <Badge label="WHAT DOES NOT" variant="neutral" />
            <Heading level={2}>Disposable execution state</Heading>
            <p>VM memory, host memory, and an in-flight evaluator are temporary. They can be rebuilt from the journal.</p>
          </Card>
        </div>

        <div className="durability-principles">
          <Card padding={3}><strong>One authority</strong><span>Sweatpants owns scheduling and recovery.</span></Card>
          <Card padding={3}><strong>One authoring call</strong><span>Loop rounds do not re-prompt the model.</span></Card>
          <Card padding={3}><strong>One next effect</strong><span>Replay skips outcomes already accepted.</span></Card>
        </div>
      </VStack>
    </Theme>
  );
}
