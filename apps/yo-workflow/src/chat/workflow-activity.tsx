import { Button } from "../design-system/primitives.tsx";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ReactChatUIPart } from "@sweatpants/react-chat";
import { activeWork, toolLabel, type ActiveWork } from "./activity.ts";

export const CancelWorkflow = createContext<(() => Promise<void>) | undefined>(undefined);

export const CurrentWorkflowActivity = createContext<readonly ActiveWork[]>([]);

type ToolPart = Extract<ReactChatUIPart, { type: "tool-call" }>;

/** Ownership is recorded by the runtime. Source parsing cannot establish a live stack. */
function isSettled(part: ReactChatUIPart): boolean {
  switch (part.type) {
    case "tool-call":
      return part.state === "output-available";
    case "activity":
      return part.state === "complete" || part.state === "cancelled";
    case "elicit":
      return part.state === "responded";
    default:
      return false;
  }
}

function ActivityTransition({ children }: { children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) {
      return;
    }
    const measure = () => {
      const next = element.getBoundingClientRect().height;
      setHeight(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="workflow-transition" style={{ height }}>
      <div ref={content} className="workflow-transition-content">
        {children}
      </div>
    </div>
  );
}

export function WorkflowActivity({
  part,
  render,
}: {
  part: ToolPart;
  render: (part: ReactChatUIPart) => ReactNode;
}) {
  const [initialIds] = useState(() => new Set(part.parts.map((child) => child.id)));
  const [knownIds, setKnownIds] = useState(() => part.parts.map((child) => child.id));
  const unseen = part.parts.filter((child) => !knownIds.includes(child.id));
  const slots = unseen.length ? [...knownIds, ...unseen.map((child) => child.id)] : knownIds;
  if (unseen.length) {
    setKnownIds(slots);
  }
  const current = useContext(CurrentWorkflowActivity);
  const cancel = useContext(CancelWorkflow);
  const [cancelling, setCancelling] = useState(false);
  const work = activeWork(part).filter(
    (entry) =>
      current.some((active) => active.id === entry.id) ||
      entry.label === "Submitting reply" ||
      entry.label === "Resuming workflow",
  );
  const occurrences = new Map<string, number>();
  const entries = part.parts.map((child) => {
    const name = child.type === "tool-call" ? child.name : undefined;
    const occurrence = name ? (occurrences.get(name) ?? 0) + 1 : undefined;
    if (name && occurrence) {
      occurrences.set(name, occurrence);
    }
    return { child, name, occurrence };
  });
  return (
    <div className="workflow-execution">
      {(entries.length > 0 || work.length > 0) && (
        <section aria-label="Workflow timeline" className="workflow-timeline">
          <div className="tool-heading">
            <strong>Timeline</strong>
            <span className="hint">execution order</span>
          </div>
          <ol>
            {[...entries, undefined].map((entry) => {
              if (!entry) {
                return work.length > 0 ? (
                  <li
                    key={`slot-${slots.length}`}
                    className="workflow-now"
                    data-working={work.some(
                      (item) =>
                        !["Waiting for input", "Reply needs attention"].includes(item.label),
                    )}
                  >
                    <span className="workflow-tick" aria-hidden="true">
                      •
                    </span>
                    <div role="status" aria-live="polite" aria-label="Current activity">
                      {work.map((item) => (
                        <p key={item.id}>
                          <strong>{item.label}</strong>
                        </p>
                      ))}
                    </div>
                  </li>
                ) : null;
              }
              const { child, name, occurrence } = entry;
              const slot = slots.indexOf(child.id);
              return (
                <li
                  key={`slot-${slot}`}
                  data-settled={isSettled(child)}
                  className={initialIds.has(child.id) ? undefined : "workflow-arriving"}
                >
                  <span className="workflow-tick" aria-hidden="true">
                    {slot + 1}
                  </span>
                  <div className="workflow-event">
                    {name && (
                      <div className="workflow-event-heading">
                        <span>{toolLabel(name)}</span>
                        <small>Call {occurrence}</small>
                      </div>
                    )}
                    <ActivityTransition>{render(child)}</ActivityTransition>
                  </div>
                </li>
              );
            })}
          </ol>
          {(work.length > 0 || cancelling) && (
            <div className="workflow-controls">
              <Button
                variant="ghost"
                color="secondary"
                size="sm"
                type="button"
                disabled={cancelling || !cancel}
                onClick={() => {
                  if (!cancel || cancelling) {
                    return;
                  }
                  setCancelling(true);
                  void cancel().finally(() => setCancelling(false));
                }}
              >
                {cancelling ? "Cancelling…" : "Cancel workflow"}
              </Button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
