import { useEffect, type ReactNode } from "react";
import { makePlugin, type ReactRenderableProps } from "@sweatpants/react-chat";
import type { TypedDocumentObservation } from "@sweatpants/agent-sdk";
import type { Json } from "@sweatpants/foundation";
import { documentObservationSchema } from "@sweatpants/durable-execution";
import { z } from "zod";
import {
  presentChoices,
  displayDocument,
  documentPresentationSchema,
} from "../workflow/tools/documents.ts";
import { Button, Card, Stack, Badge } from "../design-system/primitives.tsx";

type ChoiceResponse =
  | { action: "accept"; content: { id: string } }
  | { action: "decline" }
  | { action: "cancel" };
function Choices({
  message,
  choices,
  layout,
  columns,
  presentationOnly = false,
  observation,
  onRespond,
  disabled,
  response,
}: ReactRenderableProps<ChoiceResponse> & {
  message: string;
  choices: { id: string; label: string; disabled?: boolean }[];
  columns: number;
  presentationOnly?: boolean;
  layout: "list" | "grid";
  observation: TypedDocumentObservation<Json>;
}) {
  const { current, changes } = observation;
  return (
    <Card.Root padding={4}>
      <Stack gap={3}>
        <strong>{message}</strong>
        <Stack direction="horizontal" gap={2}>
          <span>{current.name}</span>
          <Badge>Revision {current.revision}</Badge>
        </Stack>
        <pre className="document-content">{JSON.stringify(current.content, null, 2)}</pre>
        {changes.kind === "delta" && changes.patches.length > 0 && (
          <details open>
            <summary>Changed since revision {changes.from}</summary>
            <ul>
              {changes.patches.map((patch, index) => (
                <li key={index}>
                  <mark>{patch.path.length ? patch.path.join(" / ") : "Entire document"}</mark>
                  {patch.op === "remove" ? " removed" : ` → ${JSON.stringify(patch.value)}`}
                </li>
              ))}
            </ul>
          </details>
        )}
        {response && !presentationOnly ? (
          <p>
            {response.action === "accept"
              ? `Selected: ${choices.find((choice) => choice.id === response.content.id)?.label ?? response.content.id}`
              : response.action === "decline"
                ? "Declined"
                : "Cancelled"}
          </p>
        ) : (
          <>
            <div
              className={layout === "grid" ? "document-choices-grid" : "document-choices-list"}
              style={
                layout === "grid"
                  ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }
                  : undefined
              }
            >
              {choices.map((choice) => (
                <Button
                  key={choice.id}
                  type="button"
                  disabled={disabled || presentationOnly || choice.disabled}
                  onClick={() => onRespond({ action: "accept", content: { id: choice.id } })}
                >
                  {choice.label}
                </Button>
              ))}
            </div>
            {!presentationOnly && (
              <Stack direction="horizontal" gap={2}>
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onRespond({ action: "decline" })}
                >
                  Decline
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => onRespond({ action: "cancel" })}
                >
                  Cancel
                </Button>
              </Stack>
            )}
          </>
        )}
      </Stack>
    </Card.Root>
  );
}

export const choicesPlugin = makePlugin(presentChoices)
  .onElicit({
    choose: function* (input, ctx) {
      const observation = yield* ctx.documents.content.read();
      return yield* ctx.render(Choices, { ...input.context, observation });
    },
  })
  .build();

function DocumentDisplay({
  onRespond,
  disabled,
  response,
  ...props
}: Omit<Parameters<typeof Choices>[0], "onRespond" | "disabled" | "response"> &
  ReactRenderableProps<{}>) {
  useEffect(() => {
    if (!disabled && !response) {
      onRespond({});
    }
  }, [disabled, response, onRespond]);
  return <Choices {...props} presentationOnly disabled onRespond={() => {}} />;
}
export const documentDisplayPlugin = makePlugin(displayDocument)
  .onElicit({
    display: function* (input, ctx) {
      const observation = yield* ctx.documents.content.read();
      const result = yield* ctx.render(DocumentDisplay, { ...input.context, observation });
      return { action: "accept" as const, content: result };
    },
  })
  .build();

const savedPresentationSchema = z.object({
  context: documentPresentationSchema,
  documents: z.object({ content: documentObservationSchema }),
});

/** Reconstruct only this presentation's saved revision; never read the latest document. */
export function SettledDocument({ context, fallback }: { context: unknown; fallback: ReactNode }) {
  const saved = savedPresentationSchema.safeParse(context);
  if (!saved.success) {
    return fallback;
  }
  return (
    <Choices
      {...saved.data.context}
      observation={saved.data.documents.content}
      presentationOnly
      disabled
      onRespond={() => {}}
    />
  );
}
