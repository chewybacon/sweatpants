import type { ReactRenderableProps } from "@sweatpants/react-chat";
import type { Card } from "../cards";

export interface CardPickerProps extends ReactRenderableProps<{ picked: Card }> {
  cards: Card[];
  prompt: string;
}

export function CardPicker({ cards, prompt, onRespond, disabled, response }: CardPickerProps) {
  if (disabled && response) {
    return (
      <div className="my-2 p-3 bg-muted rounded-lg">
        <p className="text-sm text-muted-foreground mb-2">{prompt}</p>
        <div className="flex gap-2 flex-wrap">
          {cards.map((card) => (
            <button
              type="button"
              key={`${card.rank}-${card.suit}`}
              disabled
              className={`
                min-h-11 px-3 py-2 rounded border text-lg font-mono
                ${
                  card.display === response.picked.display
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-muted-foreground/20 text-muted-foreground/50"
                }
              `}
            >
              {card.display}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground mt-2">You picked: {response.picked.display}</p>
      </div>
    );
  }

  return (
    <div className="my-2 p-3 bg-muted rounded-lg">
      <p className="text-sm text-muted-foreground mb-2">{prompt}</p>
      <div className="flex gap-2 flex-wrap">
        {cards.map((card) => (
          <button
            type="button"
            key={`${card.rank}-${card.suit}`}
            onClick={() => onRespond({ picked: card })}
            disabled={disabled}
            className={`
              min-h-11 px-3 py-2 rounded border text-lg font-mono
              transition-colors
              ${
                disabled
                  ? "cursor-not-allowed opacity-50"
                  : "hover:border-primary hover:bg-primary/10 cursor-pointer"
              }
              border-muted-foreground/40
            `}
          >
            {card.display}
          </button>
        ))}
      </div>
    </div>
  );
}

CardPicker.displayName = "CardPicker";
