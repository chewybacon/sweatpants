import { createFileRoute } from "@tanstack/react-router";
import { VStack } from "@astryxdesign/core/VStack";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Card } from "@astryxdesign/core/Card";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <VStack gap={8}>
      <VStack gap={4}>
        <Text color="accent">Sweatpants</Text>
        <Heading level={1} type="display-2">
          Yo Chat
        </Heading>
        <Text color="secondary">Building conversational interfaces with TanStack Start.</Text>
      </VStack>
      <Card padding={6}>
        <VStack gap={3}>
          <Text color="accent">Up next</Text>
          <Heading level={2}>Pick a card</Heading>
          <Text color="secondary">
            Our first interaction will connect an authored tool to a React card picker.
          </Text>
        </VStack>
      </Card>
    </VStack>
  );
}
