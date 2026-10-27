/** In-memory values must be structured-cloneable. Equality defines duplicate delivery. */
export interface MemoryJournalOptions {
  readonly program: string;
  readonly equals: (left: unknown, right: unknown) => boolean;
}
