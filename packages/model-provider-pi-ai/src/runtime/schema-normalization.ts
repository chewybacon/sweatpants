/** Shared record inspection for the exact provider compatibility mechanisms. */
export function isProviderRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
