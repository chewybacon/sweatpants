import { useCallback, useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";

interface InputBarProps {
  readonly onSubmit: (value: string) => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
}

export function InputBar({
  onSubmit,
  disabled = false,
  placeholder = "Ask about the codebase...",
}: InputBarProps) {
  const [value, setValue] = useState("");
  const handleSubmit = useCallback(
    (input: string) => {
      const text = input.trim();
      if (text && !disabled) {
        onSubmit(text);
        setValue("");
      }
    },
    [disabled, onSubmit],
  );

  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1}>
      {disabled ? (
        <Text color="cyan">
          <Spinner type="dots" />{" "}
        </Text>
      ) : (
        <Text color="gray">&gt; </Text>
      )}
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder={disabled ? "Thinking..." : placeholder}
      />
    </Box>
  );
}
