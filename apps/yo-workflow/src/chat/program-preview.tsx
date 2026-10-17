import { useMemo } from "react";
import { createProgramFlow } from "./program-flow.ts";
import { createSchemeFlow } from "./scheme-flow.ts";
import { ProgramCanvas } from "./program-canvas.tsx";

export function ProgramPreview({
  source,
  language = "tisyn",
}: {
  source: string;
  language?: "scheme" | "tisyn";
}) {
  const plan = useMemo(() => {
    try {
      return {
        value: language === "scheme" ? createSchemeFlow(source) : createProgramFlow(source),
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [source, language]);
  return (
    <section className="program-preview">
      <details className="logic-plan">
        <summary>{plan.error ? "Source preview" : "Program map"}</summary>
        {plan.error ? (
          <p className="preview-error" role="status">
            Program source cannot be diagrammed: {plan.error}
          </p>
        ) : (
          <>
            {plan.value && <ProgramCanvas key={source} flow={plan.value} />}
            {plan.value?.truncated && (
              <p className="hint">
                Preview limit reached. Additional structure is available in source.
              </p>
            )}
          </>
        )}
      </details>
      <details className="source">
        <summary>{language === "scheme" ? "Scheme source" : "Tisyn source"}</summary>
        <pre>
          <code>{source}</code>
        </pre>
      </details>
      {plan.value && plan.value.source !== source && (
        <details className="source">
          <summary>Expanded Tisyn</summary>
          <pre>
            <code>{plan.value.source}</code>
          </pre>
        </details>
      )}
    </section>
  );
}
