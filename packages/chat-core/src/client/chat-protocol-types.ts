import type { CustomEvent } from "@ag-ui/core";
import type { Json } from "@sweatpants/foundation";

export type StructuredOutputStartEvent = CustomEvent & {
  readonly name: "structured-output.start";
  readonly value: { readonly messageId: string };
};

export type StructuredOutputCompleteEvent = CustomEvent & {
  readonly name: "structured-output.complete";
  readonly value: {
    readonly messageId?: string;
    readonly object: Json;
    readonly raw: string;
    readonly reasoning?: string;
  };
};

export type JsonPatchOperation =
  | { readonly op: "add" | "replace" | "test"; readonly path: string; readonly value: Json }
  | { readonly op: "remove"; readonly path: string }
  | { readonly op: "move" | "copy"; readonly path: string; readonly from: string };
