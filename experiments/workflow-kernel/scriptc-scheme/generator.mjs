import { readFileSync } from "node:fs";
import { project } from "./project.mjs";
const module = JSON.parse(readFileSync(new URL("./review.ir.json", import.meta.url), "utf8"));
const text = readFileSync(new URL("./review.ts", import.meta.url), "utf8");
export const source = project(module, text).payload + "\n(review %input)";
