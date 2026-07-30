/**
 * Shared NDJSON helpers for product acceptance suites.
 * Durable handler frames are `{ lsn, event }` where `event` is the AG-UI payload.
 */
import { z } from "zod";

const durableEventSchema = z.looseObject({ type: z.string().optional() });
const durableFrameSchema = z.looseObject({
  lsn: z.number().optional(),
  event: durableEventSchema.optional(),
  type: z.string().optional(),
});

export type DurableEvent = z.infer<typeof durableEventSchema>;
export type DurableFrame = z.infer<typeof durableFrameSchema>;

/** The NDJSON line is the only untrusted text; frames are typed after this. */
export function parseDurableNdjson(text: string): DurableFrame[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => durableFrameSchema.parse(JSON.parse(line)));
}

export function unwrapEvents(frames: DurableFrame[]): DurableEvent[] {
  return frames.map((frame) => frame.event ?? frame);
}

export async function readDurableEvents(response: Response): Promise<DurableEvent[]> {
  const text = await response.text();
  return unwrapEvents(parseDurableNdjson(text));
}

export function eventsOfType(events: DurableEvent[], type: string): DurableEvent[] {
  return events.filter((event) => event.type === type);
}
