/** Shared direct-NDJSON helpers for product acceptance suites. */
import { z } from "zod";

const durableEventSchema = z.looseObject({ type: z.string() });

export type DurableEvent = z.infer<typeof durableEventSchema>;
export type NativeFrame = DurableEvent;

/** The NDJSON line is the only untrusted text; values are direct native frames. */
export function parseDurableNdjson(text: string): NativeFrame[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => durableEventSchema.parse(JSON.parse(line)));
}

export function unwrapEvents(frames: NativeFrame[]): DurableEvent[] {
  return frames;
}

export async function readDurableEvents(response: Response): Promise<DurableEvent[]> {
  return parseDurableNdjson(await response.text());
}

export function eventsOfType(events: DurableEvent[], type: string): DurableEvent[] {
  return events.filter((event) => event.type === type);
}
