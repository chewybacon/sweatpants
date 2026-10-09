import type { ReactRenderableProps } from "@sweatpants/react-chat";
import type { Card } from "../cards";

export interface CardPickerProps extends ReactRenderableProps<{ picked: Card }> {
  cards: Card[];
  prompt: string;
}

export function CardPicker({ cards, prompt, onRespond, disabled, response }: CardPickerProps) {
  return (
    <div className="card-picker">
      <p className="text-sm text-muted-foreground">{prompt}</p>
      <div className="card-hand">
        {cards.map((card) => (
          <button
            type="button"
            key={card.display}
            aria-label={card.display}
            disabled={disabled}
            onClick={() => onRespond({ picked: card })}
            className={`playing-card ${/[♥♦]/.test(card.display) ? "red-suit" : ""} ${response?.picked.display === card.display ? "picked" : ""}`}
          >
            <span>{card.rank}</span>
            <span className="card-suit" aria-hidden="true">
              {card.display.slice(-1)}
            </span>
          </button>
        ))}
      </div>
      {response && <p className="text-sm text-primary">You picked: {response.picked.display}</p>}
    </div>
  );
}

CardPicker.displayName = "CardPicker";
