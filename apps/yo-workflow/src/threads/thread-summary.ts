import type { ReactChatUIMessage, ReactChatUIPart } from "@sweatpants/react-chat";
import { toolStatus } from "../chat/activity.ts";
import { stringField } from "../chat/reply.tsx";

export interface ThreadSummary {
  title: string;
  status: string;
}

/** Read the selected conversation projection, never infer ownership from Scheme source. */
export function summarizeThread(
  messages: readonly ReactChatUIMessage[],
): ThreadSummary | undefined {
  type Tool = Extract<ReactChatUIPart, { type: "tool-call" }>;
  const workflows: Tool[] = [];
  function visit(part: ReactChatUIPart) {
    if (part.type === "tool-call" && part.name === "scheme") {
      // A validation call is authoring work, not the workflow being run.
      if (
        !(
          part.input &&
          typeof part.input === "object" &&
          !Array.isArray(part.input) &&
          part.input.validateOnly === true
        )
      )
        workflows.push(part);
      return;
    }
    if (part.type === "message") part.message.parts.forEach(visit);
    else if (part.type === "activity" || part.type === "tool-call") part.parts.forEach(visit);
  }
  messages.forEach((message) => message.parts.forEach(visit));
  const workflow =
    [...workflows]
      .reverse()
      .find((part) => !["output-available", "output-error"].includes(part.state)) ??
    workflows.at(-1);
  const prompt = messages
    .find((message) => message.role === "user")
    ?.parts.filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ");
  function nestedTitle(parts: readonly ReactChatUIPart[]): string | undefined {
    for (const part of parts) {
      if (part.type === "tool-call") {
        const title = stringField(part.input, "title");
        if (title?.trim()) return title;
      }
      const children =
        part.type === "message" ? part.message.parts : "parts" in part ? part.parts : [];
      const title = nestedTitle(children);
      if (title) return title;
    }
    return undefined;
  }
  const childTitle = workflow && nestedTitle(workflow.parts);
  const title = (stringField(workflow?.input, "title") || prompt || childTitle)
    ?.replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return title ? { title, status: workflow ? toolStatus(workflow) : "Conversation" } : undefined;
}

/** A disposable display cache. The journal projection refreshes it when the thread is opened. */
export function readThreadSummary(id: string): ThreadSummary | undefined {
  const raw = localStorage.getItem(`yo-workflow.summary.${id}`);
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      value &&
      typeof value === "object" &&
      "title" in value &&
      "status" in value &&
      typeof value.title === "string" &&
      typeof value.status === "string"
    )
      return { title: value.title, status: value.status };
  } catch (error) {
    console.warn("[yo-workflow] Could not read thread summary", error);
  }
  return undefined;
}

export function rememberThreadSummary(id: string, summary: ThreadSummary) {
  localStorage.setItem(`yo-workflow.summary.${id}`, JSON.stringify(summary));
}
