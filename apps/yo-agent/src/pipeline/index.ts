/** Terminal-specific frame processors and Ink renderer. */
import { terminalMarkdown } from "./processors/terminal-markdown.ts";
import { terminalCode } from "./processors/terminal-code.ts";

export const terminalProcessors = [terminalMarkdown, terminalCode];

export { terminalMarkdown } from "./processors/terminal-markdown.ts";
export { terminalCode, DEFAULT_THEME } from "./processors/terminal-code.ts";
export { FrameRenderer, frameToPlainText, frameToAnsi } from "./renderer/FrameRenderer.tsx";
export type { Frame, Block, Processor } from "@sweatpants/frame-renderer";
export { emptyFrame, renderFrameToRendered, renderFrameToRaw } from "@sweatpants/frame-renderer";
