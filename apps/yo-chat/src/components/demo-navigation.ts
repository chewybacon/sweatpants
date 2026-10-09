import { MessageSquare, Layers, Spade, Plane, Sigma, Grid3X3, Bot } from "lucide-react";

export const demos = [
  {
    to: "/chat/basic",
    label: "Chat",
    description: "A little space to think out loud.",
    icon: MessageSquare,
  },
  {
    to: "/chat/threaded",
    label: "Threads",
    description: "Pick up right where you left off.",
    icon: Layers,
  },
  { to: "/chat/cards", label: "Cards", description: "Draw a hand. Make your pick.", icon: Spade },
  {
    to: "/chat/flight",
    label: "Flights",
    description: "Find a flight and choose your seat.",
    icon: Plane,
  },
  {
    to: "/chat/math",
    label: "Math",
    description: "Work through it, one step at a time.",
    icon: Sigma,
  },
  {
    to: "/chat/tictactoe",
    label: "Tic-tac-toe",
    description: "Your move. A quick game against AI.",
    icon: Grid3X3,
  },
  { to: "/chat/play-ttt", label: "Agent game", description: "One tool, a whole game.", icon: Bot },
] as const;
