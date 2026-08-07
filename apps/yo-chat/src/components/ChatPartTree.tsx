import type { ReactNode } from "react";
import type { ReactChatUIMessage, ReactRenderPart, ReactChatUIPart } from "@sweatpants/react-chat";

export type AppChatPart = ReactChatUIPart;
export type AppLocalPart = ReactRenderPart;

/** Application-owned recursive renderer for prepared local parts. */
export function renderNestedParts(parts: readonly AppChatPart[]): ReactNode[] {
  return parts.flatMap((part) => {
    if (part.type === "render") {
      return [part.node];
    }
    if (part.type === "message") {
      return renderMessageParts(part.message);
    }
    if (part.type === "tool-call" || part.type === "activity" || part.type === "elicit") {
      return renderNestedParts(part.parts);
    }
    return [];
  });
}

function renderMessageParts(message: ReactChatUIMessage): ReactNode[] {
  return renderNestedParts(message.parts);
}
