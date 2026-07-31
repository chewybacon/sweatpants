import { createContext } from "effection";
import type { Json } from "@sweatpants/foundation";

/** Authority-established placement evidence for the currently executing effect. */
export interface ProgramPlacementContextValue {
  readonly journal: { readonly id: string; readonly incarnation: string };
  readonly program: { readonly id: string; readonly version: string; readonly digest: string };
  readonly route: Json;
  readonly driverKind: string;
}

/** Scoped authority evidence, not a swappable service seam. */
export const ProgramPlacementContext = createContext<ProgramPlacementContextValue | undefined>(
  "durable-effects:placement",
  undefined,
);
