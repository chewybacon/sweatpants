import type { Json } from "./json.ts";

/** Safe error DTO permitted across portable persistence and transport boundaries. */
export type SerializedApplicationError = { code: string; message: string; details?: Json };
