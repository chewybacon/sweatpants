import { Button, Card, Heading, Stack } from "../design-system/primitives.tsx";

const examples = [
  {
    title: "Play Rock, Paper, Scissors",
    prompt:
      "Play one round of rock, paper, scissors with me. Choose your move randomly before asking for mine, keep your choice hidden until I answer, and then show both moves and who won.",
  },
  {
    title: "Plan a get-together",
    prompt:
      "Help me collect RSVPs for Alex, Sam, and Jo. Ask me about one person at a time. If they're coming, ask what they'd like to eat; if not, move on. At the end, give me a guest list and the meal orders.",
  },
  {
    title: "Play Bulls and Cows",
    prompt:
      "Let's play Bulls and Cows. I'm thinking of a four-digit number with no repeated digits and no leading zero. You guess; I'll tell you the bulls and cows. Keep track of our guesses until you solve it.",
  },
  {
    title: "Name my bookstore",
    prompt:
      "Help me find a name for a cozy neighborhood bookstore. Suggest one name at a time and ask what I think. If I don't like it, use my feedback to improve the next suggestion. When I pick one, give me the name and a short tagline.",
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
            Play a game, plan something together, or explore an idea. Choose an example and make it
            your own.
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
