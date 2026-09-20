import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { AgentRuntimeState, TelemetryStats } from '../types.js';

export interface HeaderProps {
  state: AgentRuntimeState;
  modelName: string;
  workspacePath: string;
  stats: TelemetryStats;
}

export const Header: React.FC<HeaderProps> = ({
  state,
  modelName,
  workspacePath,
  stats,
}) => {
  const formatTime = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const getStatusBadge = () => {
    switch (state) {
      case 'RUNNING':
        return (
          <Text color="cyan" bold>
            <Spinner type="dots" /> RUNNING
          </Text>
        );
      case 'BLOCKED':
        return (
          <Text color="yellow" bold>
            ⏸ BLOCKED (APPROVAL)
          </Text>
        );
      case 'COMPLETED':
        return (
          <Text color="green" bold>
            ✓ COMPLETED
          </Text>
        );
      case 'FAILED':
        return (
          <Text color="red" bold>
            ✗ FAILED
          </Text>
        );
      case 'PENDING':
        return (
          <Text color="blue" bold>
            ⏳ PENDING
          </Text>
        );
      default:
        return (
          <Text color="gray" bold>
            ● READY
          </Text>
        );
    }
  };

  const shortWorkspace = workspacePath.split('/').filter(Boolean).slice(-2).join('/') || workspacePath;

  return (
    <Box
      borderStyle="round"
      borderColor={state === 'RUNNING' ? 'cyan' : state === 'BLOCKED' ? 'yellow' : 'gray'}
      paddingX={1}
      justifyContent="space-between"
      flexDirection="row"
    >
      <Box flexDirection="row" gap={2}>
        <Text bold color="magenta">
          🤖 MyAgent
        </Text>
        {getStatusBadge()}
        <Text color="gray">|</Text>
        <Text color="blue">
          Model: <Text bold color="white">{modelName}</Text>
        </Text>
        <Text color="gray">|</Text>
        <Text color="dim">
          Workspace: <Text color="white">{shortWorkspace}</Text>
        </Text>
      </Box>

      <Box flexDirection="row" gap={2}>
        <Text color="yellow">
          ⏱ {formatTime(stats.elapsedSeconds)}
        </Text>
        <Text color="gray">|</Text>
        <Text color="green">
          ⚡ {stats.totalTokens.toLocaleString()} Tok
        </Text>
        {stats.toolCallsCount > 0 && (
          <>
            <Text color="gray">|</Text>
            <Text color="cyan">
              ⚙️ {stats.toolCallsCount} Tools
            </Text>
          </>
        )}
      </Box>
    </Box>
  );
};
