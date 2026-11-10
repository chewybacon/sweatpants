import { useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { defineToolUI, type ToolUIProps } from "@sweatpan.tsx/chat";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Grid } from "@astryxdesign/core/Grid";
import { Divider } from "@astryxdesign/core/Divider";
import { Text } from "@astryxdesign/core/Text";
import { bookFlight, pickFlight, pickSeat } from "../tools/book-flight.ts";

const styles = stylex.create({
  seat: {
    width: "clamp(var(--spacing-7), 6vw, var(--spacing-9))",
    height: "clamp(var(--spacing-7), 6vw, var(--spacing-9))",
    minWidth: 0,
    paddingInline: 0,
    paddingBlock: 0,
    borderWidth: "var(--border-width)",
    borderStyle: "solid",
    borderColor: "var(--color-border-emphasized)",
  },
  unavailable: {
    borderColor: "var(--color-border)",
    borderStyle: "dashed",
    backgroundColor: "var(--color-background-muted)",
  },
  selected: {
    borderColor: "var(--color-text-accent)",
  },
  confirm: {
    position: "sticky",
    bottom: 0,
    backgroundColor: "var(--color-background-card)",
    paddingBlock: "var(--spacing-3)",
    zIndex: 1,
    borderTopWidth: "var(--border-width)",
    borderTopStyle: "solid",
    borderTopColor: "var(--color-border)",
  },
  cabin: {
    marginInline: "auto",
    backgroundColor: "var(--color-background-body)",
    borderRadius: "var(--spacing-6)",
    borderWidth: "var(--border-width)",
    borderStyle: "solid",
    borderColor: "var(--color-border)",
  },
});

function FlightChoices({
  input,
  respond,
  disabled,
  submitted,
  outcome,
}: ToolUIProps<typeof pickFlight>) {
  const selected = outcome?.ok ? outcome.value : submitted?.ok ? submitted.value : undefined;
  const flight = input.flights.find((flight) => flight.id === selected?.flightId);
  if (flight) {
    return (
      <VStack gap={2}>
        <HStack gap={2} justify="between" wrap="wrap">
          <Text color="accent" weight="semibold">
            ✓ Flight selected: {flight.flightNumber}
          </Text>
          <Text weight="semibold">${flight.price}</Text>
        </HStack>
        <Text>
          {input.route.from} → {input.route.destination}
        </Text>
        <Text color="secondary">
          {flight.airline} · {flight.departure}–{flight.arrival} · {flight.duration}
        </Text>
        {!outcome && <Text role="status">Confirming your flight…</Text>}
        <Divider />
      </VStack>
    );
  }
  return (
    <VStack gap={5}>
      <VStack gap={2}>
        <Text type="supporting" color="accent" weight="semibold">
          STEP 1 OF 2 · FLIGHT
        </Text>
        <Text type="large" weight="semibold">
          {input.route.from} → {input.route.destination}
        </Text>
        <Text color="secondary">Three flights. Choose the departure that suits you.</Text>
      </VStack>
      {input.flights.map((flight, index) => (
        <VStack key={flight.id} gap={4}>
          {index > 0 && <Divider />}
          <HStack gap={4} justify="between" align="center" wrap="wrap">
            <VStack gap={1}>
              <Text type="large" weight="semibold">
                {flight.departure} → {flight.arrival}
              </Text>
              <Text>{flight.airline}</Text>
              <Text type="supporting">
                {flight.flightNumber} · {flight.duration}
              </Text>
            </VStack>
            <VStack gap={2} align="end">
              <Text type="large" weight="bold">
                ${flight.price}
              </Text>
              <Button
                label={`Choose ${flight.flightNumber}`}
                isDisabled={disabled}
                onClick={() => void respond({ flightId: flight.id })}
              >
                Select
              </Button>
            </VStack>
          </HStack>
        </VStack>
      ))}
    </VStack>
  );
}

function SeatChoices({
  input,
  respond,
  disabled,
  submitted,
  outcome,
}: ToolUIProps<typeof pickSeat>) {
  const [draft, setDraft] = useState<{ row: number; seat: string }>();
  const committed = outcome?.ok ? outcome.value : submitted?.ok ? submitted.value : undefined;
  const selected = committed ?? draft;
  const code = selected ? `${selected.row}${selected.seat}` : undefined;
  const position =
    selected?.seat === "A" || selected?.seat === "F"
      ? "Window"
      : selected?.seat === "C" || selected?.seat === "D"
        ? "Aisle"
        : "Middle";
  if (committed) {
    return (
      <HStack justify="between" align="center" gap={3} wrap="wrap">
        <VStack gap={1}>
          <Text color="accent" weight="semibold">
            ✓ Seat selected: {code}
          </Text>
          <Text color="secondary">
            {position} seat · {input.flight.flightNumber}
          </Text>
        </VStack>
        {!outcome && <Text role="status">Confirming booking…</Text>}
      </HStack>
    );
  }
  const groups = [input.seatMap.seatsPerRow.slice(0, 3), input.seatMap.seatsPerRow.slice(3)];
  return (
    <VStack gap={4}>
      <VStack gap={2}>
        <Text type="supporting" color="accent" weight="semibold">
          STEP 2 OF 2 · SEAT
        </Text>
        <Text type="large" weight="semibold">
          Find your spot on board
        </Text>
        <Text color="secondary">Select a seat, then confirm your simulated booking.</Text>
      </VStack>
      <HStack gap={4} wrap="wrap" aria-label="Seat legend">
        <Text type="supporting" color="primary">
          □ Available
        </Text>
        <Text type="supporting" color="accent">
          ✓ Selected
        </Text>
        <Text type="supporting">× Unavailable</Text>
      </HStack>
      <VStack
        gap={3}
        align="center"
        padding={3}
        maxWidth="calc(var(--spacing-10) * 12)"
        width="100%"
        xstyle={styles.cabin}
      >
        <Text type="supporting" color="secondary">
          FRONT OF CABIN ↑
        </Text>
        <HStack gap={1} align="center" aria-hidden="true">
          <VStack width="clamp(var(--spacing-7), 6vw, var(--spacing-9))" />
          {groups.map((letters, group) => (
            <HStack key={group} gap={1}>
              {group === 1 && <VStack width="var(--spacing-4)" />}
              <Grid columns={3} gap={1}>
                {letters.map((letter) => (
                  <VStack
                    key={letter}
                    width="clamp(var(--spacing-7), 6vw, var(--spacing-9))"
                    align="center"
                  >
                    <Text type="supporting">{letter}</Text>
                  </VStack>
                ))}
              </Grid>
            </HStack>
          ))}
        </HStack>
        <VStack gap={1} aria-label="Seat map">
          {Array.from({ length: input.seatMap.rows }, (_, index) => index + 1).map((row) => (
            <HStack key={row} gap={1} align="center">
              <VStack width="clamp(var(--spacing-7), 6vw, var(--spacing-9))" align="center">
                <Text type="supporting">{row}</Text>
              </VStack>
              {groups.map((letters, group) => (
                <HStack key={group} gap={1}>
                  {group === 1 && <VStack width="var(--spacing-4)" />}
                  <Grid columns={3} gap={1}>
                    {letters.map((seat) => {
                      const seatCode = `${row}${seat}`;
                      const taken = input.seatMap.taken.includes(seatCode);
                      const chosen = code === seatCode;
                      return (
                        <Button
                          key={seat}
                          label={`${seatCode}${taken ? " unavailable" : ""}`}
                          aria-pressed={chosen}
                          variant={chosen ? "primary" : "secondary"}
                          isDisabled={disabled || taken}
                          xstyle={[
                            styles.seat,
                            taken && styles.unavailable,
                            chosen && styles.selected,
                          ]}
                          onClick={() => setDraft({ row, seat })}
                        >
                          {taken ? "×" : chosen ? "✓" : "\u00a0"}
                        </Button>
                      );
                    })}
                  </Grid>
                </HStack>
              ))}
            </HStack>
          ))}
        </VStack>
      </VStack>
      <HStack justify="between" align="center" wrap="wrap" gap={3} xstyle={styles.confirm}>
        <VStack gap={1}>
          <Text weight="semibold">{code ? `Seat ${code} · ${position}` : "Choose your seat"}</Text>
          <Text type="supporting">No payment · demo ticket only</Text>
        </VStack>
        <Button
          label={code ? `Confirm seat ${code}` : "Confirm seat"}
          variant="primary"
          isDisabled={disabled || !selected}
          onClick={() => {
            if (selected) {
              void respond(selected);
            }
          }}
        />
      </HStack>
    </VStack>
  );
}

export const flightUI = defineToolUI(bookFlight, {
  pickFlight: FlightChoices,
  pickSeat: SeatChoices,
});
