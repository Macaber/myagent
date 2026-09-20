import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import { PendingApproval } from '../types.js';

export interface ApprovalModalProps {
  approval: PendingApproval;
}

export const ApprovalModal: React.FC<ApprovalModalProps> = ({ approval }) => {
  const items = [
    { label: '🟢 允许单次执行 (Allow Once)', value: 'approved' as const },
    { label: '🛡️  当前会话永久允许此工具 (Always Allow)', value: 'approved_always' as const },
    { label: '🔴 拒绝本次执行 (Reject)', value: 'rejected' as const },
  ];

  const handleSelect = (item: { value: 'approved' | 'approved_always' | 'rejected' }) => {
    approval.respond(item.value);
  };

  const getRiskBadge = () => {
    const risk = String(approval.riskLevel).toUpperCase();
    if (risk.includes('HIGH')) return <Text color="red" bold>[高风险 HIGH_RISK]</Text>;
    if (risk.includes('WRITE')) return <Text color="yellow" bold>[写操作 WORKSPACE_WRITE]</Text>;
    if (risk.includes('NETWORK')) return <Text color="magenta" bold>[网络访问 NETWORK]</Text>;
    return <Text color="blue">[只读 READ_ONLY]</Text>;
  };

  const argsPreview = approval.arguments
    ? JSON.stringify(approval.arguments, null, 1).replace(/\n/g, ' ')
    : '';

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="red"
      paddingX={2}
      paddingY={1}
      marginY={1}
    >
      <Box flexDirection="row" gap={1}>
        <Text bold color="red">
          ⚠️ 权限审批拦截 (HITL Approval Required):
        </Text>
        {getRiskBadge()}
      </Box>

      <Box flexDirection="row" gap={1} marginTop={1}>
        <Text bold color="yellow">
          工具: <Text color="white">{approval.toolName}</Text>
        </Text>
        {argsPreview && (
          <Text color="gray">
            参数: <Text color="cyan">{argsPreview.length > 80 ? argsPreview.slice(0, 80) + '...' : argsPreview}</Text>
          </Text>
        )}
      </Box>

      <Box marginTop={0}>
        <Text color="white">{approval.description}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold color="green">
          请选择决策 (使用上下方向键选择，回车确认):
        </Text>
        <SelectInput items={items} onSelect={handleSelect} />
      </Box>
    </Box>
  );
};
