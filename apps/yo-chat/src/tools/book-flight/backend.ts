import type { Flight, SeatMap } from "../schemas/book-flight.ts";

export function mockFlightSearch(_from: string, _destination: string): Flight[] {
  // Simulate flight search - in production this would call an API
  return [
    {
      id: "FL001",
      airline: "SkyHigh Airways",
      flightNumber: "SH 142",
      departure: "08:00",
      arrival: "11:30",
      duration: "3h 30m",
      price: 299,
    },
    {
      id: "FL002",
      airline: "CloudAir",
      flightNumber: "CA 287",
      departure: "12:45",
      arrival: "16:00",
      duration: "3h 15m",
      price: 349,
    },
    {
      id: "FL003",
      airline: "JetStream",
      flightNumber: "JS 901",
      departure: "18:30",
      arrival: "22:00",
      duration: "3h 30m",
      price: 249,
    },
  ];
}

export function mockSeatMap(): SeatMap {
  return {
    rows: 10,
    seatsPerRow: ["A", "B", "C", "D", "E", "F"],
    taken: ["1A", "1B", "2C", "3D", "4A", "4B", "4C", "5F", "6A", "7B", "8C", "9D", "10E"],
  };
}

export function generateTicketNumber(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "TKT-";
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
