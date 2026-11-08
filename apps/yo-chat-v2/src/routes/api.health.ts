import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: () => Response.json({ status: "ok" }),
      HEAD: () => new Response(null, { headers: { "Content-Type": "application/json" } }),
      ANY: () => new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } }),
    },
  },
});
