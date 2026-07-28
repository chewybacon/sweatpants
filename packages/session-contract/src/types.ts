/** Canonical JSON value accepted across durable process and persistence boundaries. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Safe error DTO permitted in journals and public runtime results. */
export type SerializedApplicationError = { code: string; message: string; details?: Json };
