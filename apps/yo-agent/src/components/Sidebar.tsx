import { Box, Text } from "ink";

interface SidebarProps {
  readonly error: string | null;
}

export function Sidebar({ error }: SidebarProps) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="gray">
        Local tools
      </Text>
      <Box marginTop={1} marginLeft={1} flexDirection="column">
        <Text color="gray">• read_file</Text>
        <Text color="gray">• glob</Text>
        <Text color="gray">• grep</Text>
        <Text color="gray">• git_status</Text>
        <Text color="gray">• git_diff</Text>
        <Text color="gray">• git_log</Text>
        <Text color="gray">• ask_user</Text>
      </Box>

      {error && (
        <Box marginTop={1} flexDirection="column">
          <Text color="red" bold>
            Error:
          </Text>
          <Text color="red" wrap="wrap">
            {error}
          </Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column" flexGrow={1} justifyContent="flex-end">
        <Text color="gray" dimColor>
          ─────────
        </Text>
        <Text color="gray" dimColor>
          ^C: exit
        </Text>
      </Box>
    </Box>
  );
}
