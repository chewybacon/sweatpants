import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createConversationViewer } from "./conversation-viewer.ts";
import { FileConversationPanel } from "./file-question-ui.tsx";

/** Application-local browser entry. Owns its React root and viewer, but not the
 * supplied transport or server execution. Dispose before reusing the container. */
export function createFileConversationClient(
  container: Element,
  transport: Parameters<typeof createConversationViewer>[0],
) {
  const root = createRoot(container);
  const viewer = createConversationViewer(transport);
  root.render(
    <StrictMode>
      <FileConversationPanel viewer={viewer} />
    </StrictMode>,
  );
  let disposed = false;
  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        root.unmount();
      } finally {
        viewer.close();
      }
    },
  };
}
