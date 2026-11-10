import { useStandaloneTool } from "../standalone/use-standalone-tool.ts";
import { ToolUIProvider, ToolOutlet } from "@sweatpan.tsx/chat";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { cardUI } from "./card-ui.tsx";
import { pickCard } from "../tools/pick-card";

const plugins = [cardUI];

export function CardPicker({
  fetch: send,
}: {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}) {
  const tool = useStandaloneTool(pickCard, {
    endpoint: "/api/cards",
    storageKey: "yo-chat:pick-card:v3",
    fetch: send,
  });
  const terminal = tool.view?.status === "completed" || tool.view?.status === "cancelled";
  return (
    <VStack gap={4} aria-busy={tool.busy}>
      <Heading level={2}>Pick a card</Heading>
      <Text color="secondary">
        Choose a card, then come back to the same result—even after a reload.
      </Text>
      <VStack gap={3} aria-live="polite">
        {!tool.loaded && <Text>Restoring your interaction…</Text>}
        {tool.view?.status === "completed" && (
          <Text>You picked {tool.view.value.card.display}.</Text>
        )}
        {tool.view?.status === "cancelled" && <Text>This interaction has ended.</Text>}
        {tool.error && <Text role="alert">{tool.error}</Text>}
        {tool.pending && !terminal && <Text>Waiting for confirmation.</Text>}
      </VStack>
      <ToolUIProvider source={tool.presentation} plugins={plugins}>
        <ToolOutlet />
      </ToolUIProvider>
      <HStack gap={3} wrap="wrap">
        {tool.loaded && (!tool.execution || terminal) && (
          <Button
            label={terminal ? "Pick another card" : "Start picking"}
            variant="primary"
            isDisabled={tool.busy}
            onClick={() => void tool.start({})}
          />
        )}
        {tool.execution && !terminal && (
          <>
            {tool.pending ? (
              <Button
                label="Retry same answer"
                variant="primary"
                isDisabled={tool.busy}
                onClick={() => void tool.retry()}
              />
            ) : (
              (!tool.view || tool.view.status === "running") && (
                <Button
                  label={tool.view ? "Continue picking" : "Retry start"}
                  variant="primary"
                  isDisabled={tool.busy}
                  onClick={() => void tool.retry()}
                />
              )
            )}
            <Button
              label="Check status"
              isDisabled={tool.busy}
              onClick={() => void tool.refresh()}
            />
          </>
        )}
      </HStack>
      <Text type="supporting">
        This tab remembers your place. Reloading doesn’t choose another card.
      </Text>
    </VStack>
  );
}
