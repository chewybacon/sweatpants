import type { FlightClient, FlightPart } from "./flight-view-contract.ts";
import { firstFlightAnswer, flightPartLabel } from "./flight-view-presentation.ts";

/** Minimal non-React subscription binding. Replaces its DOM on each snapshot;
 * production focus preservation and keyed reconciliation are not established here. */
export function createFlightDomView(container: HTMLElement, client: FlightClient) {
  let active = true;
  function render() {
    const snapshot = client.getSnapshot();
    container.replaceChildren();
    function append(parts: readonly FlightPart[], parent: HTMLElement) {
      for (const part of parts) {
        const section = document.createElement("section");
        section.dataset.node = part.id;
        const text = document.createElement("p");
        text.textContent = flightPartLabel(part);
        section.append(text);
        parent.append(section);
        if ("parts" in part) {
          append(part.parts, section);
        }
      }
    }
    if (snapshot.view) {
      append(snapshot.view.messages, container);
    }
    for (const target of snapshot.view?.questions ?? []) {
      const button = document.createElement("button");
      button.textContent = `Answer ${target.question.kind}`;
      button.addEventListener("click", () => {
        if (!active) {
          return;
        }
        void client
          .answer(firstFlightAnswer(target))
          .then(() => client.refresh())
          .catch(() => {
            if (!active) {
              return;
            }
            const error = document.createElement("p");
            error.setAttribute("role", "alert");
            error.textContent = "Answer not confirmed. Reconnect before choosing again.";
            container.append(error);
          });
      });
      container.append(button);
    }
  }
  const unsubscribe = client.subscribe(render);
  render();
  return {
    dispose() {
      active = false;
      unsubscribe();
      container.replaceChildren();
    },
  };
}
