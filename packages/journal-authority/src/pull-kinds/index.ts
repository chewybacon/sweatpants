/**
 * Pull-kind definitions: each interaction kind declares its descriptor schema
 * and resolution policy once; kernel layers and the snapshot codec consume the
 * registry generically. Importing this module performs registration.
 */
export * from "./registry.ts";
export * from "./kinds.ts";
export * from "./wire.ts";
export * from "./elicit.ts";
export * from "./wait.ts";
export * from "./children.ts";
export * from "./sample.ts";
export * from "./foreign.ts";
