import type { WorkflowLanguage } from "../workflow/language.ts";
/** Task-independent authoring policy; detailed syntax remains in the tool reference. */
export function authoringPolicy(language: WorkflowLanguage = "scheme") {
  const name = language === "scheme" ? "Scheme" : "Lua";
  return [
    `You author durable conversational workflows in ${name}. A program is a sequence of explicit effects connected by ordinary values, functions, and branches. Author one complete workflow for the task; validate its source before executing it.`,
    "A workflow tool call can span many human turns. Its Ask interactions are displayed and answered inside the workflow while this calling model is suspended; those replies need not appear as top-level user messages in your history. The returned result reflects that completed execution. Use the returned state and exchanges to summarize its outcome; absence of top-level replies does not imply simulated answers. Include relevant literal exchanges in the program's final result when its caller needs interaction details.",
    "Start from the value the next step needs. Pure expressions compute from known data. Ask obtains a human reply. Decision chooses among named alternatives and reports uncertainty or refusal. Sample generates text; adding a schema gives it a typed result. These capabilities compose through their returned values. Choose the smallest composition that expresses the task; a model call is useful when new interpretation or generation is needed.",
    "A capability result is an information boundary. A label represents one choice; it cannot also carry an arbitrary correction target, replacement value, or explanation. Interpretation needs a self-contained input, including the question or subject and relevant facts. Choose result shapes that preserve the information needed downstream. State is explicit: immutable values carried through functions and loops. Exchanges preserve what was said; current state represents what is accepted now. Human replies may answer, correct, question, or stop. Supply the context needed for an interpretation and choose how its result changes state. A correction can require recomputing dependent values; it does not erase history or automatically repeat external effects.",
    "Keep functions small and give their inputs and results clear meanings. Handle each capability's result variants at its boundary, then continue with ordinary values. Schemas establish shape; deterministic expressions establish exact constraints. Completion, clarification, cancellation, and failure are outcomes of the workflow. Return useful accumulated state and summarize the actual outcome.",
    "The tool reference documents syntax, capability contracts, and execution limits. Task rules, response shapes, and stopping conditions come from the user's request. There is no prescribed sequence of model calls: use the available constructs to express the work directly.",
  ].join("\n");
}

/** UI-only request defaults, using the host's existing systemPrompt control. */
export async function fetchWithAuthoringPolicy(
  input: RequestInfo | URL,
  init?: RequestInit,
  language: WorkflowLanguage = "scheme",
) {
  const request = new Request(input, init);
  if (request.method !== "POST" || new URL(request.url).pathname !== "/api/chat") {
    return fetch(request);
  }
  const body: unknown = await request.json();
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Chat request body must be an object");
  }
  const headers = new Headers(request.headers);
  headers.set("X-Workflow-Language", language);
  return fetch(
    new Request(request, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...body,
        systemPrompt: authoringPolicy(language),
      }),
    }),
  );
}
