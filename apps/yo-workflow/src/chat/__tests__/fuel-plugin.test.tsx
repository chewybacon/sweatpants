import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FuelApproval } from "../fuel-plugin.tsx";

afterEach(cleanup);
it("offers Continue and Cancel and preserves the accepted display on reload", () => {
  const respond = vi.fn();
  const props = { message: "This workflow needs more computation to finish", onRespond: respond };
  const view = render(<FuelApproval {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(respond).toHaveBeenLastCalledWith({ action: "accept", content: {} });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(respond).toHaveBeenLastCalledWith({ action: "cancel" });
  view.rerender(<FuelApproval {...props} response={{ action: "accept", content: {} }} />);
  expect(screen.getByText("Continued")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});
it("disables both actions while a response is pending", () => {
  const respond = vi.fn();
  render(<FuelApproval message="More computation needed" onRespond={respond} disabled />);
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(respond).not.toHaveBeenCalled();
});
