import { Box, Text } from "ink";

export function StatusBar() {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Box gap={1}>
        <Text bold>yo-agent</Text>
        <Text color="gray">|</Text>
        <Text color="cyan" bold>
          [IN PROCESS]
        </Text>
        <Text color="gray">| tools hot-reload</Text>
      </Box>
      <Text color="gray">^C: exit</Text>
    </Box>
  );
}
