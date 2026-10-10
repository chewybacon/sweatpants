import { useEffect, useState } from "react";
import { Badge, Button, Card, Heading, HStack, Link, Theme, VStack } from "@astryxdesign/core";
import { neutralTheme } from "@astryxdesign/theme-neutral";

export function ThreadList() {
  const [threads, setThreads] = useState<string[]>([]);
  useEffect(() => {
    const current = localStorage.getItem("yo-tisyn.thread");
    const saved = JSON.parse(localStorage.getItem("yo-tisyn.threads") ?? "[]") as string[];
    setThreads([...new Set([current, ...saved].filter((id): id is string => Boolean(id)))]);
  }, []);
  return (
    <Theme theme={neutralTheme}>
      <VStack gap={4} className="thread-list-island">
        <HStack hAlign="between" vAlign="center" wrap="wrap">
          <VStack gap={1}>
            <Badge label="LOCAL INDEX" variant="teal" />
            <Heading level={1} type="display-2">
              Your threads
            </Heading>
            <p>
              Conversation IDs are stored in this browser. The durable history lives behind each
              thread.
            </p>
          </VStack>
          <Button label="New thread" variant="primary" href="/playground" />
        </HStack>
        {threads.length === 0 ? (
          <Card padding={5} variant="muted">
            <VStack gap={2}>
              <Heading level={2}>No browser threads yet</Heading>
              <p>Start a workflow and this browser will keep a link to it here.</p>
              <Link href="/playground">Open the playground →</Link>
            </VStack>
          </Card>
        ) : (
          <div className="thread-grid">
            {threads.map((id, index) => (
              <Card key={id} padding={4} className="thread-card">
                <VStack gap={3}>
                  <HStack hAlign="between" vAlign="center">
                    <Badge
                      label={index === 0 ? "CURRENT" : "RECENT"}
                      variant={index === 0 ? "success" : "neutral"}
                    />
                    <span className="thread-number">#{index + 1}</span>
                  </HStack>
                  <code>{id}</code>
                  <Link href={`/threads/${id}`}>Open thread →</Link>
                </VStack>
              </Card>
            ))}
          </div>
        )}
      </VStack>
    </Theme>
  );
}
