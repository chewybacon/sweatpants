import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SeatPicker } from "../tools/book-flight/components/SeatPicker";

afterEach(cleanup);

describe("seat selection", () => {
  it("confirms the labelled seat and prevents selecting occupied seats", () => {
    const onRespond = vi.fn();
    render(
      <SeatPicker
        seatMap={{ rows: 2, seatsPerRow: ["A", "B", "C", "D", "E", "F"], taken: ["1A"] }}
        message="Choose a seat"
        onRespond={onRespond}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "Seat 1A, taken" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Choose a seat to continue" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Seat 2C" }));
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Seat 2C" }));
    expect(onRespond).toHaveBeenCalledWith({ row: 2, seat: "C" });
  });
});
