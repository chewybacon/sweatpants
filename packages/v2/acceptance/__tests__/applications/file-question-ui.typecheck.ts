import type { FileQuestionProps } from "../../examples/file-question-ui.tsx";
import type { ConversationQuestion } from "../../examples/file-conversation-view.ts";

// @ts-expect-error The form submits text, not arbitrary values.
export const wrongAnswer: FileQuestionProps["answer"] = async (
  _question: ConversationQuestion,
  _answer: number,
) => ({ receipt: "x", duplicate: false });

// @ts-expect-error A successful local callback is not a server acceptance receipt.
export const missingReceipt: FileQuestionProps["answer"] = async () => undefined;
