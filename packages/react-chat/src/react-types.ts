import type { ReactNode } from "react";
import type { Json } from "@sweatpants/foundation";
import type { ChatLocalPart } from "@sweatpants/chat-client";

/** Frontend-local prepared render node; never part of generic host snapshots. */
export interface ReactRenderPart extends ChatLocalPart {
  readonly type: "render";
  readonly parentElicitId: string;
  readonly sequence: number;
  readonly state: "pending" | "completed";
  readonly node: ReactNode;
  readonly response?: Json;
  readonly disabled?: boolean;
}
