import { call, type Operation } from "effection";
import type { ReactElement } from "react";
import { within } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

/** Mount real React UI and observe its DOM. No client actions or assertions. */
export function renderUI(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  // Keep asynchronous protocol-driven updates outside unit-test act batching.
  flushSync(() => root.render(element));
  const queries = within(container);
  const pending = new Set<(reason: Error) => void>();
  let disposed = false;

  function* waitForElement<T extends HTMLElement>(
    description: string,
    query: () => T | null,
  ): Operation<T> {
    if (disposed) {
      throw new Error("UI has been unmounted");
    }
    return yield* call(
      () =>
        new Promise<T>((resolve, reject) => {
          const observer = new MutationObserver(check);
          const timer = setTimeout(
            () =>
              fail(
                new Error(
                  `Timed out waiting for ${description}\n${container.innerHTML.slice(-3500)}`,
                ),
              ),
            10_000,
          );
          function cleanup() {
            observer.disconnect();
            clearTimeout(timer);
            pending.delete(fail);
          }
          function fail(reason: Error) {
            cleanup();
            reject(reason);
          }
          function check() {
            try {
              const found = query();
              if (found) {
                cleanup();
                resolve(found);
              }
            } catch (error) {
              cleanup();
              reject(error);
            }
          }
          pending.add(fail);
          observer.observe(container, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
          });
          check();
        }),
    );
  }

  return {
    ...queries,
    waitForElement,
    *waitForText(text: string): Operation<HTMLElement> {
      return yield* waitForElement(`text ${JSON.stringify(text)}`, () => queries.queryByText(text));
    },
    *waitForEnabledButton(name: string): Operation<HTMLButtonElement> {
      return yield* waitForElement(`enabled button ${JSON.stringify(name)}`, () => {
        const button = queries.queryByRole<HTMLButtonElement>("button", { name });
        return button && !button.disabled ? button : null;
      });
    },
    [Symbol.dispose]() {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const fail of pending) {
        fail(new Error("UI unmounted while waiting for an element"));
      }
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}
