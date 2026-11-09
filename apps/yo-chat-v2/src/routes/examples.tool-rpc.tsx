import { createFileRoute } from "@tanstack/react-router";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { Card } from "@astryxdesign/core/Card";
import { CardPicker } from "../cards/CardPicker";

export const Route = createFileRoute("/examples/tool-rpc")({ component: StandaloneTool });

function StandaloneTool() {
  return (
    <VStack gap={6}>
      <Text color="secondary">
        Standalone example: open a picker directly, without a conversation or model. Your choice and
        result survive a reload.
      </Text>
      <Card padding={6}>
        <CardPicker />
      </Card>
    </VStack>
  );
}
