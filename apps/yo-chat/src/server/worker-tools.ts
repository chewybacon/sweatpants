import { tools } from "./tool-definitions";

/** Ordinary execution remains distinct from crank-native programs. */
export const workerTools = tools.filter((tool) => tool.execution !== "crank_native");
