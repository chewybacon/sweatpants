import { useEffect, useState } from "react";
import { Badge, Button, Card, Heading, Link, Stack } from "../design-system/primitives.tsx";

import { readThreadIds } from "./thread-index.ts";

export function ThreadList() {
  const [threads, setThreads] = useState<string[]>([]);
  useEffect(() => {
    setThreads(readThreadIds());
  }, []);
  return (
    <Stack gap={5} className="thread-list-island">
      <Stack direction="horizontal" justify="between" align="end" gap={4} wrap>
        <Stack gap={2}>
          <Badge tone="primary">Local index</Badge>
          <Heading level={1} size="title">
            Your threads
          </Heading>
          <p>Threads opened in this browser. Open one to continue where you left off.</p>
        </Stack>
        <Button href="/playground">
          New thread <span aria-hidden="true">＋</span>
        </Button>
      </Stack>
      {threads.length === 0 ? (
        <Card.Root padding={5} tone="muted">
          <Stack gap={3}>
            <Heading level={2} size="section">
              No threads yet
            </Heading>
            <p>Start a workflow and find it here when you return.</p>
            <Link href="/playground">Open the playground →</Link>
          </Stack>
        </Card.Root>
      ) : (
        <div className="thread-grid">
          {threads.map((id, index) => (
            <Card.Root key={id} padding={4} className="thread-card">
              <Stack gap={4}>
                <Badge tone={index === 0 ? "success" : "neutral"}>
                  {index === 0 ? "Current" : "Recent"}
                </Badge>
                <code>{id}</code>
                <Link href={`/threads/${id}`}>Open thread →</Link>
              </Stack>
            </Card.Root>
          ))}
        </div>
      )}
    </Stack>
  );
}
