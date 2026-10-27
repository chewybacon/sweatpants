export type IteratorGuestState =
  | "new"
  | "advancing"
  | "suspended"
  | "completed"
  | "cancelled"
  | "failed"
  | "closed";
