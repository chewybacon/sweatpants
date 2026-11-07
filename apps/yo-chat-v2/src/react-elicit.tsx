export function SeatPicker({
  flight,
  seats,
  onRespond,
}: {
  readonly flight: string;
  readonly seats: readonly string[];
  readonly onRespond: (seat: "2A" | "2B") => void;
}) {
  return (
    <fieldset>
      <legend>Choose a seat for {flight}</legend>
      {(["2A", "2B"] as const)
        .filter((seat) => seats.includes(seat))
        .map((seat) => (
          <button key={seat} onClick={() => onRespond(seat)}>
            Seat {seat}
          </button>
        ))}
    </fieldset>
  );
}
