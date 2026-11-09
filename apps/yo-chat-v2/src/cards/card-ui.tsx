import { defineToolUI } from "@sweatpan.tsx/chat";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { pickCard } from "../tools/pick-card.ts";

export const cardUI = defineToolUI(pickCard, {
  chooseCard: ({ input, respond, disabled, submitted, outcome }) => {
    const selected = outcome?.ok ? outcome.value : submitted?.ok ? submitted.value : undefined;
    return (
      <VStack gap={3}>
        <Text>{input.prompt}</Text>
        <HStack gap={2} wrap="wrap">
          {input.cards.map((card) => (
            <Button
              key={card.display}
              label={card.display}
              size="lg"
              variant={selected?.display === card.display ? "primary" : "secondary"}
              isDisabled={disabled}
              onClick={() => void respond(card)}
            />
          ))}
        </HStack>
        {selected && <Text color="secondary">You picked: {selected.display}</Text>}
      </VStack>
    );
  },
});
