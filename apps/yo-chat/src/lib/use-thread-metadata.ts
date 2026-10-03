import { useEffect } from "react";
import type { ThreadSummary } from "./threaded-chat-types";

type Summary = Pick<ThreadSummary, "title" | "lastMessagePreview" | "messageCount">;

/** Coalesces streaming sidebar writes and flushes settled turns without waiting. */
export function useThreadMetadata({
  threadId,
  summary,
  busy,
  ready,
  onMetadata,
}: {
  threadId: string;
  summary: Summary;
  busy: boolean;
  ready: boolean;
  onMetadata: (threadId: string, summary: Summary) => void;
}): void {
  const { title, lastMessagePreview, messageCount } = summary;
  useEffect(() => {
    // Hydration must not overwrite a stored summary with an empty transcript.
    if (!ready) {
      return;
    }
    const next = { title, lastMessagePreview, messageCount };
    if (!busy) {
      onMetadata(threadId, next);
      return;
    }
    const timer = setTimeout(() => onMetadata(threadId, next), 250);
    return () => clearTimeout(timer);
  }, [title, lastMessagePreview, messageCount, busy, ready, onMetadata, threadId]);
}
