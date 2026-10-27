export type IteratorGuestState =
  | "new"
  | "advancing"
  | "suspended"
  | "completed"
  | "failed"
  | "closed";
