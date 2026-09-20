import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { PlanData } from '../types.js';

export interface PlanProgressProps {
  plan?: PlanData;
}

export const PlanProgress: React.FC<PlanProgressProps> = ({ plan }) => {
  if (!plan || !plan.milestones || plan.milestones.length === 0) {
    return null;
  }

  const completedCount = plan.milestones.filter((m) => m.status === 'completed').length;
  const totalCount = plan.milestones.length;
  const percent = Math.round((completedCount / totalCount) * 100);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="blue"
      paddingX={1}
      marginY={0}
    >
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="cyan">
          📋 任务执行计划 (DAG): <Text color="white">{plan.goal}</Text>
        </Text>
        <Text color="yellow">
          进度: {completedCount}/{totalCount} ({percent}%)
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={0}>
        {plan.milestones.map((m, index) => {
          const isLast = index === plan.milestones.length - 1;
          const prefix = isLast ? '└─' : '├─';

          if (m.status === 'completed') {
            return (
              <Box key={m.id} flexDirection="row" gap={1}>
                <Text color="gray">{prefix}</Text>
                <Text color="green" bold>[✓]</Text>
                <Text color="green">{m.title}</Text>
              </Box>
            );
          }

          if (m.status === 'in_progress') {
            return (
              <Box key={m.id} flexDirection="row" gap={1}>
                <Text color="gray">{prefix}</Text>
                <Text color="cyan" bold>
                  <Spinner type="dots" />
                </Text>
                <Text color="cyan" bold>{m.title}</Text>
                {m.description && <Text color="gray">({m.description})</Text>}
              </Box>
            );
          }

          if (m.status === 'failed') {
            return (
              <Box key={m.id} flexDirection="row" gap={1}>
                <Text color="gray">{prefix}</Text>
                <Text color="red" bold>[✗]</Text>
                <Text color="red">{m.title}</Text>
              </Box>
            );
          }

          return (
            <Box key={m.id} flexDirection="row" gap={1}>
              <Text color="gray">{prefix}</Text>
              <Text color="dim">[ ]</Text>
              <Text color="dim">{m.title}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};
