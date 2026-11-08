export type Frame =
  | { readonly kind: "request"; readonly id: number; readonly value: unknown }
  | {
      readonly kind: "response";
      readonly id: number;
      readonly ok: boolean;
      readonly value: unknown;
    };

export interface PendingReply {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}
