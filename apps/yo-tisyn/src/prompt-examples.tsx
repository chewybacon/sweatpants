import { Badge, Button, Card, Heading, HStack, VStack } from "@astryxdesign/core";

const examples = [
  {
    title: "Loop until I decline",
    prompt: "ask me for input in a loop until I decline, echo the accumulated response as it goes",
    badge: "Durable loop",
  },
  {
    title: "Combine two replies",
    prompt:
      "Ask me for two words, then echo them joined with a space. Stop if I decline or cancel.",
    badge: "Typed input",
  },
  {
    title: "Try a simple echo",
    prompt: 'Echo "hello world" using one Tisyn program.',
    badge: "First step",
  },
];

export function PromptExamples({ onSelect }: { onSelect: (prompt: string) => void }) {
  return (
    <Card className="empty-state" padding={5} variant="muted" aria-labelledby="examples-title">
      <VStack gap={2}>
        <HStack gap={2} vAlign="center">
          <Badge label="START HERE" variant="teal" />
          <span className="eyebrow">One program, many durable rounds</span>
        </HStack>
        <Heading id="examples-title" level={2}>
          What would you like to try?
        </Heading>
        <p>Choose an example to fill the task below. You can edit it before sending.</p>
        <div className="prompt-examples">
          {examples.map((example) => (
            <Card key={example.title} className="prompt-example" variant="default" padding={4}>
              <VStack gap={2}>
                <Badge label={example.badge} variant="neutral" />
                <strong>{example.title}</strong>
                <span>{example.prompt}</span>
                <Button
                  label={`Use ${example.title}`}
                  variant="secondary"
                  size="sm"
                  onClick={() => onSelect(example.prompt)}
                />
              </VStack>
            </Card>
          ))}
        </div>
      </VStack>
    </Card>
  );
}
