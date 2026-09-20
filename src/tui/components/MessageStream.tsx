import React from 'react';
import { Box, Text } from 'ink';
import { UIMessage } from '../types.js';
import { ToolCallView } from './ToolCallView.js';

export interface MessageStreamProps {
  messages: UIMessage[];
  maxDisplay?: number;
}

export const MessageStream: React.FC<MessageStreamProps> = ({
  messages,
  maxDisplay = 20,
}) => {
  const visibleMessages = messages.slice(-maxDisplay);

  return (
    <Box flexDirection="column" marginY={1}>
      {visibleMessages.map((msg) => {
        switch (msg.type) {
          case 'user':
            return (
              <Box key={msg.id} marginY={0} flexDirection="row" gap={1}>
                <Text bold color="green">
                  👤 You:
                </Text>
                <Text bold color="white">
                  {msg.content}
                </Text>
              </Box>
            );

          case 'thought':
            return (
              <Box key={msg.id} marginY={0} paddingLeft={2} flexDirection="row" gap={1}>
                <Text color="gray" italic>
                  💭 {msg.content}
                </Text>
              </Box>
            );

          case 'tool':
            if (!msg.toolCall) return null;
            return (
              <Box key={msg.id} marginY={0}>
                <ToolCallView toolCall={msg.toolCall} />
              </Box>
            );

          case 'system':
            return (
              <Box key={msg.id} marginY={0} paddingLeft={1}>
                <Text color="magenta">{msg.content}</Text>
              </Box>
            );

          case 'agent':
          default:
            return (
              <Box key={msg.id} marginY={0} flexDirection="column">
                <Text bold color="cyan">
                  🤖 Agent:
                </Text>
                <Box paddingLeft={2}>
                  <Text color="white">{msg.content}</Text>
                </Box>
              </Box>
            );
        }
      })}
    </Box>
  );
};
