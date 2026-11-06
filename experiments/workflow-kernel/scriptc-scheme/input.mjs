import { readFileSync } from "node:fs";
import { effects } from "./contract.mts";
const read = (name) => readFileSync(new URL(`./workflow/${name}`, import.meta.url), "utf8");
export const authored = read("review.workflow.ts");
export const helper = read("helper.ts");
export const input = {
  source: { language: "typescript", id: "review.workflow.ts", text: authored },
  modules: { "helper.ts": helper },
  effects,
};
