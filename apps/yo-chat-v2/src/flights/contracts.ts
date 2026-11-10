import { z } from "zod";

export const flight = z.object({
  id: z.string(),
  airline: z.string(),
  flightNumber: z.string(),
  departure: z.string(),
  arrival: z.string(),
  duration: z.string(),
  price: z.number(),
});
export const route = z.object({ from: z.string().min(1), destination: z.string().min(1) });
export const seatMap = z.object({
  rows: z.number().int().min(1).max(30),
  seatsPerRow: z.array(z.string()),
  taken: z.array(z.string()),
});
export const flightChoice = z.object({ flightId: z.string() });
export const seatChoice = z.object({ row: z.number().int().min(1), seat: z.string() });
export const flightInput = z.object({ route, flights: z.array(flight) });
export const seatInput = z.object({ flight, seatMap });
export const booking = z.object({
  ticket: z.string(),
  flight,
  seat: z.string(),
  route,
  travelTip: z.string(),
});
export function offeredFlight(
  input: z.infer<typeof flightInput>,
  value: z.infer<typeof flightChoice>,
) {
  return input.flights.find((flight) => flight.id === value.flightId);
}
export function availableSeat(input: z.infer<typeof seatInput>, value: z.infer<typeof seatChoice>) {
  return (
    value.row <= input.seatMap.rows &&
    input.seatMap.seatsPerRow.includes(value.seat) &&
    !input.seatMap.taken.includes(`${value.row}${value.seat}`)
  );
}
