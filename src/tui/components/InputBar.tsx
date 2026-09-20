import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { AgentRuntimeState } from '../types.js';

export interface InputBarProps {
  state: AgentRuntimeState;
  hasPendingApproval: boolean;
  onSubmit: (text: string) => void;
  onClearInput?: () => void;
}

export const InputBar: React.FC<InputBarProps> = ({
  state,
  hasPendingApproval,
  onSubmit,
}) => {
  const [value, setValue] = useState('');

  const handleSubmit = (submittedText: string) => {
    const trimmed = submittedText.trim();
    if (!trimmed) return;
    setValue('');
    onSubmit(trimmed);
  };

  if (hasPendingApproval) {
    return (
      <Box
        borderStyle="single"
        borderColor="yellow"
        paddingX={1}
        marginY={0}
      >
        <Text color="yellow" bold>
          ⏸ 正在等待上方操作权限审批... 请在弹窗中选择并回车
        </Text>
      </Box>
    );
  }

  if (state === 'RUNNING') {
    return (
      <Box
        borderStyle="single"
        borderColor="cyan"
        paddingX={1}
        marginY={0}
        justifyContent="space-between"
      >
        <Text color="cyan">
          ⚙️ 任务正在编排与执行中...
        </Text>
        <Text color="gray">
          按 <Text color="yellow" bold>Ctrl+C</Text> 取消当前任务
        </Text>
      </Box>
    );
  }

  const isSuspended = state === 'SUSPENDED_INPUT';
  const borderColor = isSuspended ? 'yellow' : 'green';
  const placeholder = isSuspended
    ? '任务已挂起并等待输入，请输入补充指令继续执行 (/help 查看帮助)'
    : '输入任务需求或指令，按回车执行 (/help 查看帮助)';

  return (
    <Box
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      marginY={0}
      flexDirection="column"
    >
      <Box flexDirection="row" gap={1}>
        <Text bold color={borderColor}>
          {isSuspended ? '⏸ ❯' : '❯'}
        </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          focus={Boolean(process.stdin.isTTY)}
          placeholder={placeholder}
        />
      </Box>
    </Box>
  );
};
