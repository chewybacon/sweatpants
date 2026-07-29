/**
 * Shared NDJSON helpers for product acceptance suites.
 * Durable handler frames are `{ lsn, event }` where `event` is the AG-UI payload.
 */

export type DurableFrame = {
  lsn?: number;
  event?: { type?: string; [key: string]: unknown };
  type?: string;
  [key: string]: unknown;
};

export function parseDurableNdjson(text: string): DurableFrame[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DurableFrame);
}

export function unwrapEvents(
  frames: DurableFrame[],
): Array<{ type?: string; [key: string]: unknown }> {
  return frames.map((frame) => {
    if (frame.event && typeof frame.event === "object") {
      return frame.event as { type?: string; [key: string]: unknown };
    }
    return frame as { type?: string; [key: string]: unknown };
  });
}

export async function readDurableEvents(
  response: Response,
): Promise<Array<{ type?: string; [key: string]: unknown }>> {
  const text = await response.text();
  return unwrapEvents(parseDurableNdjson(text));
}

export function eventsOfType(
  events: Array<{ type?: string; [key: string]: unknown }>,
  type: string,
): Array<{ type?: string; [key: string]: unknown }> {
  return events.filter((e) => e.type === type);
}
