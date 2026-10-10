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
    <aside className="empty-state" aria-labelledby="examples-title">
      <h2 id="examples-title">What would you like to try?</h2>
      <p>Choose an example to fill the task below. You can edit it before sending.</p>
      <div className="prompt-examples">
        {examples.map((example) => (
          <button
            key={example.title}
            type="button"
            className="prompt-example"
            onClick={() => onSelect(example.prompt)}
          >
            <strong>{example.title}</strong>
            <span>{example.prompt}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
