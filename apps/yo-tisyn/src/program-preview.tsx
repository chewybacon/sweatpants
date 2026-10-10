import { useEffect, useMemo, useState } from "react";
import { run } from "effection";
import { createPipeline } from "@sweatpants/frame-renderer";
import { createProgramPlan } from "./program-plan.ts";

export function ProgramPreview({ source }: { source: string }) {
  const plan = useMemo(() => {
    try {
      return { value: createProgramPlan(source) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [source]);
  const code = plan.value?.diagram;
  const [expanded, setExpanded] = useState(false);
  const [rendered, setRendered] = useState<{ code: string; html?: string; error?: string }>();
  useEffect(() => {
    if (!code) {
      return;
    }
    let active = true;
    const task = run(function* () {
      const pipeline = createPipeline({ processors: "mermaid" });
      pipeline.push(`\`\`\`mermaid\n${code}\n\`\`\`\n`);
      const frame = yield* pipeline.flush();
      const problem = frame.trace.find(
        (entry) => entry.processor === "mermaid" && entry.action !== "update",
      );
      if (problem) {
        throw new Error(problem.detail ?? "Diagram renderer unavailable");
      }
      return frame.blocks.map((block) => block.rendered).join("");
    });
    task.then(
      // eslint-disable-next-line promise/always-return -- This callback publishes UI state, not a promise result.
      (html) => {
        if (active) {
          setRendered({ code, html });
        }
      },
      (error: unknown) => {
        if (active) {
          setRendered({ code, error: error instanceof Error ? error.message : String(error) });
        }
      },
    );
    return () => {
      active = false;
      void task.halt();
    };
  }, [code]);
  const current = rendered?.code === code ? rendered : undefined;
  const error = plan.error ?? current?.error;
  return (
    <section className="program-preview">
      <details open>
        <summary>Program plan</summary>
        <p className="hint">
          Static plan, not an execution trace. Dashed arrows link unambiguous named function calls.
          Expressions stay in labels; tool cards below show actual results.
        </p>
        {error ? (
          <p className="preview-error" role="status">
            Diagram unavailable: {error}
          </p>
        ) : current?.html ? (
          <>
            <button
              type="button"
              className="diagram-toggle"
              aria-pressed={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Fit diagram" : "Enlarge diagram"}
            </button>
            <div
              className={`program-diagram${expanded ? " expanded" : ""}`}
              role="img"
              tabIndex={0}
              aria-label="Tisyn program control flow"
              dangerouslySetInnerHTML={{ __html: current.html }}
            />
          </>
        ) : (
          <p role="status">Drawing the program…</p>
        )}
        {plan.value && (
          <details className="plan-outline">
            <summary>Diagram text</summary>
            <p className="hint">
              Node labels, including both branches. This list is not execution order.
            </p>
            <ul>
              {plan.value.steps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ul>
          </details>
        )}
      </details>
      <details className="source">
        <summary>Tisyn source</summary>
        <pre>
          <code>{plan.value?.source ?? source}</code>
        </pre>
      </details>
    </section>
  );
}
