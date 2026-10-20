import type { ExecutionView } from "./contract.ts";

export function CheckpointSummary({ view }: { view: ExecutionView }) {
  const state = view.inspection;
  if (!state) {
    return <p>No evaluator state captured yet.</p>;
  }
  const environment = state.environments.find((env) => env.id === state.currentEnvironment);
  const next = state.frames[0];
  return (
    <div className="checkpoint-summary">
      <p className="execution-muted">
        A saved execution position: values already computed, work still to do, and the effect
        waiting for a reply. The journal remains the authority.
      </p>
      <section className="checkpoint-stage">
        <h3>
          <span>1</span> Saved
        </h3>
        <p>
          {view.pending ? (
            <>
              Waiting at <code>{state.site}</code>
            </>
          ) : (
            <>Execution is {view.status}.</>
          )}
        </p>
        {view.pending && <blockquote>{view.pending.message}</blockquote>}
        <dl>
          <div>
            <dt>Position</dt>
            <dd>
              {state.steps == null ? "" : `${state.steps} evaluator steps · `}
              {state.mode}
            </dd>
          </div>
          <div>
            <dt>Values</dt>
            <dd>
              {state.currentEnvironment == null
                ? "See VM registers and heap in the checkpoint"
                : `${state.environments.length} environments; current environment ${state.currentEnvironment}`}
              {environment && (
                <small>
                  {environment.bindings.map((binding) => binding.name).join(", ") ||
                    "No local bindings"}
                </small>
              )}
            </dd>
          </div>
          <div>
            <dt>Remaining work</dt>
            <dd>
              {state.execution.availability.unwind === "unavailable"
                ? "Saved in the VM checkpoint; scope and cleanup inspection is unavailable"
                : `${state.frames.length} continuation frames, including scope and cleanup state`}
            </dd>
          </div>
        </dl>
        <details>
          <summary>Actual checkpoint data</summary>
          <p className="execution-muted">
            The accepted journal checkpoint envelope, including the kernel snapshot. Its state
            contains the serialized runtime continuation and reachable values.
          </p>
          <pre>{JSON.stringify(view.checkpoint, null, 2)}</pre>
          {!view.checkpoint && <p>No accepted checkpoint is available.</p>}
        </details>
      </section>
      <section className="checkpoint-stage">
        <h3>
          <span>2</span> Restore
        </h3>
        <p>
          Checkpoint → validate identity and state → fresh runtime instance → same waiting boundary.
        </p>
        {view.restoration ? (
          <p className="checkpoint-proof">
            Verified for this checkpoint: restoring and capturing again preserved the saved
            computation state.
          </p>
        ) : (
          <p className="execution-muted">
            {view.pending
              ? "Use “Restore in fresh instance” to inspect this checkpoint without answering the effect."
              : "The workflow has finished; no reply is pending."}
          </p>
        )}
      </section>
      <section className="checkpoint-stage">
        <h3>
          <span>3</span> Continue
        </h3>
        {view.pending ? (
          <>
            <p>
              Your reply → journal accepts it → restored evaluator receives the value → saved
              continuation runs.
            </p>
            {next && (
              <>
                <small className="execution-muted">First saved frame · {next.kind}</small>
                <pre>{next.detail}</pre>
                {next.kind === "define" && (
                  <p className="execution-muted">
                    Bind the reply to the named variable in the saved environment. The trailing
                    number is an environment ID.
                  </p>
                )}
              </>
            )}
            <p className="execution-muted">
              The prefix before this checkpoint is skipped. Accepted journal entries after it are
              applied before advancing new work.
            </p>
          </>
        ) : (
          <p>
            There is no remaining reply to deliver. The terminal result is shown beside this
            checkpoint.
          </p>
        )}
      </section>
    </div>
  );
}
