import { createElement, Fragment, useSyncExternalStore } from "react";
import type { ElicitViewsProps } from "./contracts.ts";

/** Subscription only. Unmounting a view does not cancel a shared session's handler.
 * This live presentation surface has no server-rendering snapshot contract. */
export function ElicitViews({ host, execution }: ElicitViewsProps) {
  const slots = useSyncExternalStore(host.subscribe, host.getSnapshot);
  return createElement(
    Fragment,
    null,
    ...slots
      .filter((slot) => execution === undefined || slot.interaction.execution === execution)
      .map((slot) =>
        createElement(
          "section",
          {
            key: slot.id,
            "data-execution": slot.interaction.execution,
            "data-question": slot.interaction.requestId,
          },
          slot.node,
        ),
      ),
  );
}
