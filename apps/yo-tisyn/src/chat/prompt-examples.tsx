import { Button, Card, Heading, Stack } from "../design-system/primitives.tsx";

const examples = [
  {
    title: "Loop until I decline",
    prompt: "ask me for input in a loop until I decline, echo the accumulated response as it goes",
  },
  {
    title: "Combine two replies",
    prompt:
      "Ask me for two words, then echo them joined with a space. Stop if I decline or cancel.",
  },
  {
    title: "Try a simple echo",
    prompt: 'Echo "hello world" using one Tisyn program.',
  },
];

export function PromptExamples({ onSelect }: { onSelect: (prompt: string) => void }) {
  return (
    <Card.Root className="empty-state" tone="muted" padding={5} aria-labelledby="examples-title">
      <Stack gap={4}>
        <div>
          <Heading id="examples-title" level={2} size="section">
            Choose a starting point
          </Heading>
          <p className="section-copy">
            Each example becomes a single typed program before any durable work begins.
          </p>
        </div>
        <div className="prompt-examples">
          {examples.map((example) => (
            <Card.Root key={example.title} className="prompt-example" padding={4}>
              <Stack gap={3}>
                <strong>{example.title}</strong>
                <p className="example-prompt">{example.prompt}</p>
                <Button
                  variant="outline"
                  aria-label={`Use ${example.title}`}
                  onClick={() => onSelect(example.prompt)}
                >
                  Use example
                </Button>
              </Stack>
            </Card.Root>
          ))}
        </div>
      </Stack>
    </Card.Root>
  );
}
