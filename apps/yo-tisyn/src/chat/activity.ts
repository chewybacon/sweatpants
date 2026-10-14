import type { ReactChatUIPart } from "@sweatpants/react-chat";

export function toolLabel(name: string): string {
  return (
    (
      {
        tisyn: "Tisyn workflow",
        scheme: "Scheme workflow",
        ask: "Ask you",
        sample: "Model sample",
        random: "Random draw",
        echo: "Echo",
      } as Record<string, string>
    )[name] ?? name
  );
}

export interface ActiveWork {
  id: string;
  path: readonly string[];
  label: string;
}

/** Follow owned children; a terminal or opaque boundary cannot advertise active descendants. */
export function activeWork(part: ReactChatUIPart, path: readonly string[] = []): ActiveWork[] {
  switch (part.type) {
    case "message":
      return part.message.parts.flatMap((child) => activeWork(child, path));
    case "tool-call": {
      if (part.state === "output-available" || part.state === "output-error") return [];
      const next = [...path, toolLabel(part.name)];
      const children = part.parts.flatMap((child) => activeWork(child, next));
      return children.length
        ? children
        : [
            {
              id: part.id,
              path: next,
              label: part.state === "input-streaming" ? "Preparing call" : "Awaiting result",
            },
          ];
    }
    case "activity": {
      if (part.presentation === "opaque" || part.state !== "running") return [];
      const next = [...path, part.activityType];
      const children = part.parts.flatMap((child) => activeWork(child, next));
      return children.length ? children : [{ id: part.id, path: next, label: "In progress" }];
    }
    case "elicit":
      if (part.state !== "pending") return [];
      return [
        {
          id: part.id,
          path,
          label:
            part.localState === "submitting"
              ? "Submitting reply"
              : part.localState === "failed"
                ? "Reply needs attention"
                : "Waiting for input",
        },
      ];
    case "reasoning":
      return part.state === "streaming" ? [{ id: part.id, path, label: "Thinking" }] : [];
    case "text":
      return part.state === "streaming" ? [{ id: part.id, path, label: "Writing" }] : [];
    default:
      return [];
  }
}

export function toolStatus(part: Extract<ReactChatUIPart, { type: "tool-call" }>): string {
  if (part.state === "output-available") return "Completed";
  if (part.state === "output-error") return "Failed";
  if (part.state === "input-streaming") return "Preparing call";
  const children = part.parts.flatMap((child) => activeWork(child));
  if (children.length > 1) return `${children.length} active activities`;
  return children[0]?.label ?? "Awaiting result";
}
