import type { ChatLocalPart, ChatUIMessage, ChatUIPart } from "@sweatpants/chat-core";

function sequenceOf(part: ChatLocalPart): number {
  if ("sequence" in part && typeof part.sequence === "number") {
    return part.sequence;
  }
  return 0;
}

export function overlayLocalParts<TLocalPart extends ChatLocalPart>(
  messages: readonly ChatUIMessage<TLocalPart>[],
  localParts: ReadonlyMap<string, readonly TLocalPart[]>,
): readonly ChatUIMessage<TLocalPart>[] {
  const parts = (values: readonly ChatUIPart<TLocalPart>[]): readonly ChatUIPart<TLocalPart>[] =>
    values.flatMap((part) => {
      if (part.type === "message" && "message" in part) {
        return [{ ...part, message: message(part.message) }];
      }
      if (!("parts" in part) || !Array.isArray(part.parts)) {
        return [part];
      }
      const children = parts(part.parts);
      const local =
        part.type === "elicit"
          ? [...(localParts.get(part.elicitId) ?? [])].sort(
              (left, right) => sequenceOf(left) - sequenceOf(right),
            )
          : [];
      return [{ ...part, parts: Object.freeze([...children, ...local]) }];
    });
  const message = (value: ChatUIMessage<TLocalPart>): ChatUIMessage<TLocalPart> =>
    Object.freeze({ ...value, parts: Object.freeze(parts(value.parts)) });
  return Object.freeze(messages.map(message));
}
