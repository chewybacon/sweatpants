import type { Outcome, Turn } from "@sweatpants/foundation/computation";

/** Correlation belongs to one worker generation; this is not a durable command receipt. */
export type GuestCommand<Value> = {
  generation: string;
  sequence: number;
} & ({ kind: "start" } | { kind: "resume"; outcome: Outcome<Value, unknown> } | { kind: "close" });
export type GuestResponse<T, Request> = {
  generation: string;
  sequence: number;
} & (
  | { kind: "turn"; turn: Turn<T, Request> }
  | { kind: "closed" }
  | { kind: "error"; error: { name: string; message: string } }
);
