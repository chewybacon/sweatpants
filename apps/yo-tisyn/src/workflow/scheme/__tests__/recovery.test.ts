import { expect, it } from "vitest";
import { createRecoveryHistory } from "../recovery.ts";

it("preserves accepted exchanges without copying private sampling state", () => {
  const history = createRecoveryHistory();
  const exchange = { messages: [{ role: "user", content: "1 bull" }] };
  history.record({ action: "accept", exchange });
  history.record({ status: "ok", parsed: { secret: "5827" }, exchange: { messages: ["private"] } });
  history.record({ action: "cancel" });
  expect(history.snapshot()).toEqual({ acceptedExchanges: [exchange], omittedExchanges: 0 });
});

it("reports omitted exchanges instead of silently treating partial history as complete", () => {
  const history = createRecoveryHistory();
  history.record({ action: "accept", exchange: { messages: ["x".repeat(49 * 1024)] } });
  history.record({ action: "accept", exchange: { messages: ["later reply"] } });
  expect(history.snapshot()).toEqual({
    acceptedExchanges: [{ messages: ["later reply"] }],
    omittedExchanges: 1,
  });
});
