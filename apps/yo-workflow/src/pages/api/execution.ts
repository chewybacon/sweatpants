import type { APIRoute } from "astro";

// The Node dev middleware handles this route locally. The experimental Hoot
// evaluator has not yet been packaged for workerd; fail explicitly in deployment.
export const ALL: APIRoute = () =>
  Response.json(
    {
      error:
        "The execution inspector is local-only. Run pnpm --filter yo-workflow dev and open /execution.",
    },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
