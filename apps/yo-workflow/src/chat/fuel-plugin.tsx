import { makePlugin, type ReactRenderableProps } from "@sweatpants/react-chat";
import { computationApproval } from "../workflow/tools/computation-approval.ts";
import { Button, Card, Stack } from "../design-system/primitives.tsx";

type FuelResponse = { action: "accept"; content: {} } | { action: "decline" | "cancel" };
export function FuelApproval({
  message,
  response,
  disabled,
  onRespond,
}: ReactRenderableProps<FuelResponse> & { message: string }) {
  return (
    <Card.Root padding={4}>
      <Stack gap={3}>
        <strong>{message}</strong>
        {response ? (
          <p>{response.action === "accept" ? "Continued" : "Cancelled"}</p>
        ) : (
          <Stack direction="horizontal" gap={2}>
            <Button
              disabled={disabled}
              onClick={() => onRespond({ action: "accept", content: {} })}
            >
              Continue
            </Button>
            <Button
              variant="ghost"
              disabled={disabled}
              onClick={() => onRespond({ action: "cancel" })}
            >
              Cancel
            </Button>
          </Stack>
        )}
      </Stack>
    </Card.Root>
  );
}
export const fuelPlugin = makePlugin(computationApproval)
  .onElicit({
    fuel: function* (input, context) {
      return yield* context.render(FuelApproval, input.context);
    },
  })
  .build();
