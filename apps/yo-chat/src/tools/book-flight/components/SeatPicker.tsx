import { useState } from "react";
import type { ReactRenderableProps } from "@sweatpants/react-chat";
import type { SeatMap } from "../tool";

interface SeatPickerProps extends ReactRenderableProps<{ row: number; seat: string }> {
  seatMap: SeatMap;
  message: string;
  flightInfo?: { airline: string; flightNumber: string };
}

export function SeatPicker({
  seatMap,
  message,
  flightInfo,
  onRespond,
  disabled,
  response,
}: SeatPickerProps) {
  const [selectedSeat, setSelectedSeat] = useState<{ row: number; seat: string } | null>(null);
  if (response) {
    return (
      <div className="seat-confirmation">
        <span className="eyebrow">SEAT SELECTED</span>
        <strong>
          {response.row}
          {response.seat}
        </strong>
        <span>
          {flightInfo?.airline} {flightInfo?.flightNumber}
        </span>
      </div>
    );
  }
  return (
    <div className="seat-picker">
      <p className="text-sm font-medium">{message}</p>
      {flightInfo && (
        <p className="text-xs text-muted-foreground mt-1">
          {flightInfo.airline} · {flightInfo.flightNumber}
        </p>
      )}
      <div className="seat-map" role="group" aria-label="Available seats">
        {Array.from({ length: seatMap.rows }, (_, index) => index + 1).map((row) => (
          <div
            key={row}
            className="seat-row"
            style={{
              gridTemplateColumns: `18px repeat(${seatMap.seatsPerRow.length}, minmax(0, 1fr))`,
            }}
          >
            <span className="seat-row-number">{row}</span>
            {seatMap.seatsPerRow.map((seat, index) => {
              const taken = seatMap.taken.includes(`${row}${seat}`);
              const selected = selectedSeat?.row === row && selectedSeat.seat === seat;
              return (
                <button
                  key={seat}
                  type="button"
                  disabled={disabled || taken}
                  title={taken ? "Seat taken" : `Seat ${row}${seat}`}
                  aria-label={`Seat ${row}${seat}${taken ? ", taken" : ""}`}
                  aria-pressed={selected}
                  className={`seat ${selected ? "selected" : ""} ${index === Math.floor(seatMap.seatsPerRow.length / 2) - 1 ? "aisle" : ""}`}
                  onClick={() => setSelectedSeat({ row, seat })}
                >
                  {taken ? "×" : seat}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground my-3">
        Choose an available seat. × seats are taken.
      </p>
      <button
        type="button"
        disabled={disabled || !selectedSeat}
        className="confirm-seat"
        onClick={() => {
          if (selectedSeat) {
            onRespond(selectedSeat);
          }
        }}
      >
        {selectedSeat
          ? `Confirm Seat ${selectedSeat.row}${selectedSeat.seat}`
          : "Choose a seat to continue"}
      </button>
    </div>
  );
}

SeatPicker.displayName = "SeatPicker";
