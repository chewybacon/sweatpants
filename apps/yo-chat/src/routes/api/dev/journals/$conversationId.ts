import { createFileRoute } from "@tanstack/react-router";

// Ensure the application has created and registered its ProgramDriver journal store.
import "../../../../server/chat-application";
import {
  inspectProgramDriverJournal,
  JournalInspectorError,
} from "../../../../server/journal-inspector";

export const Route = createFileRoute("/api/dev/journals/$conversationId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (
          process.env["NODE_ENV"] === "production" &&
          process.env["ENABLE_JOURNAL_INSPECTOR"] !== "yes"
        ) {
          return Response.json({ error: "not_found" }, { status: 404 });
        }
        try {
          return Response.json(await inspectProgramDriverJournal(params.conversationId));
        } catch (cause) {
          if (cause instanceof JournalInspectorError) {
            return Response.json({ error: cause.code }, { status: cause.status });
          }
          return Response.json({ error: "journal_inspection_failed" }, { status: 500 });
        }
      },
    },
  },
});
