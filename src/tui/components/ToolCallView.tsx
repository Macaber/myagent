import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { UIToolCall } from '../types.js';

export interface ToolCallViewProps {
  toolCall: UIToolCall;
}

export const ToolCallView: React.FC<ToolCallViewProps> = ({ toolCall }) => {
  const isRunning = toolCall.status === 'running';
  const isFailed = toolCall.status === 'failed';

  const truncateOutput = (raw?: string): { preview: string[]; foldedCount: number } => {
    if (!raw) return { preview: [], foldedCount: 0 };
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length <= 3) {
      return { preview: lines, foldedCount: 0 };
    }
    return {
      preview: lines.slice(0, 3),
      foldedCount: lines.length - 3,
    };
  };

  const { preview, foldedCount } = truncateOutput(toolCall.outputPreview);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={isRunning ? 'cyan' : isFailed ? 'red' : 'gray'}
      paddingX={1}
      marginY={0}
    >
      <Box flexDirection="row" gap={1}>
        {isRunning ? (
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
        ) : isFailed ? (
          <Text color="red" bold>
            ✗
          </Text>
        ) : (
          <Text color="green" bold>
            ✓
          </Text>
        )}

        <Text bold color="yellow">
          ⚙️ {toolCall.name}
        </Text>

        <Text color="white">
          {toolCall.argsSummary}
        </Text>

        {toolCall.durationMs !== undefined && (
          <Text color="gray">
            ({toolCall.durationMs}ms)
          </Text>
        )}
      </Box>

      {isFailed && toolCall.errorMessage && (
        <Box marginTop={0} paddingLeft={2}>
          <Text color="red">
            Error: {toolCall.errorMessage}
          </Text>
        </Box>
      )}

      {preview.length > 0 && (
        <Box flexDirection="column" marginTop={0} paddingLeft={2}>
          {preview.map((line, idx) => (
            <Text key={idx} color="dim">
              │ {line.length > 100 ? line.slice(0, 100) + '...' : line}
            </Text>
          ))}
          {foldedCount > 0 && (
            <Text color="gray" italic>
              └─ ... ({foldedCount} lines folded)
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
};
