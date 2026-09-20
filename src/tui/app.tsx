import React, { useState, useEffect, useRef } from 'react';
import { Box, useApp, useInput, Text } from 'ink';
import { AcpClient } from '../client/acp-client.js';
import {
  AgentRuntimeState,
  PlanData,
  UIMessage,
  UIToolCall,
  PendingApproval,
  TelemetryStats,
} from './types.js';
import { Header } from './components/Header.js';
import { PlanProgress } from './components/PlanProgress.js';
import { MessageStream } from './components/MessageStream.js';
import { ApprovalModal } from './components/ApprovalModal.js';
import { InputBar } from './components/InputBar.js';

export interface AppProps {
  client: AcpClient;
  sessionId: string;
  modelName: string;
  workspacePath: string;
  initialUpdates?: any[];
  onExit?: () => void;
}

export const App: React.FC<AppProps> = ({
  client,
  sessionId,
  modelName,
  workspacePath,
  initialUpdates,
  onExit,
}) => {
  const { exit } = useApp();
  const [state, setState] = useState<AgentRuntimeState>('IDLE');
  const [plan, setPlan] = useState<PlanData | undefined>();
  const [currentActiveSessionId, setCurrentActiveSessionId] = useState<string>(sessionId);

  // Initialize messages from replayed history if resuming
  const [messages, setMessages] = useState<UIMessage[]>(() => {
    if (!initialUpdates || initialUpdates.length === 0) return [];
    const restored: UIMessage[] = [];
    for (const notif of initialUpdates) {
      const up = notif?.update || notif;
      const type = notif?.updateType || up?.sessionUpdate || notif?.sessionUpdate;
      const content = notif?.content || up?.content;
      const text = typeof content === 'string' ? content : content?.text || '';

      if (type === 'user_message_chunk' && text) {
        restored.push({
          id: `hist_u_${restored.length}`,
          type: 'user',
          content: text,
          timestamp: Date.now(),
        });
      } else if (type === 'agent_message_chunk' && text) {
        restored.push({
          id: `hist_a_${restored.length}`,
          type: 'agent',
          content: text,
          timestamp: Date.now(),
        });
      } else if (type === 'tool_call' && up?.title) {
        restored.push({
          id: `hist_t_${up.callId || restored.length}`,
          type: 'tool',
          toolCall: {
            id: up.callId || `tool_${restored.length}`,
            name: up.title,
            argsSummary: up.rawInput ? JSON.stringify(up.rawInput) : '',
            status: 'completed',
            startedAt: Date.now(),
          },
          timestamp: Date.now(),
        });
      }
    }
    if (restored.length > 0) {
      restored.push({
        id: `sys_resume_notice_${Date.now()}`,
        type: 'system',
        content: `🔄 已恢复历史会话 [${sessionId}]，共重构 ${restored.length} 条交互记录。您可以直接输入新消息继续对话。`,
        timestamp: Date.now(),
      });
    }
    return restored;
  });
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | undefined>();
  const [stats, setStats] = useState<TelemetryStats>({
    elapsedSeconds: 0,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    toolCallsCount: 0,
  });

  const activeToolCalls = useRef<Map<string, UIToolCall>>(new Map());
  const currentAgentMessageId = useRef<string | null>(null);
  const currentThoughtMessageId = useRef<string | null>(null);

  // 1. Timer for elapsed time
  useEffect(() => {
    let interval: NodeJS.Timeout | undefined;
    if (state === 'RUNNING') {
      interval = setInterval(() => {
        setStats((prev) => ({ ...prev, elapsedSeconds: prev.elapsedSeconds + 1 }));
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [state]);

  // 2. Subscribe to ACP events
  useEffect(() => {
    // Permission listener
    const unsubscribePermission = client.onRequestPermission((req, respond) => {
      setState('BLOCKED');
      setPendingApproval({
        requestId: req.requestId || `req_${Date.now()}`,
        toolName: req.toolCall?.name || 'tool',
        description: req.description || 'Action requires approval',
        riskLevel: req.riskLevel || 'workspace_write',
        arguments: req.toolCall?.arguments,
        respond: (decision, reason) => {
          respond(decision, reason);
          setPendingApproval(undefined);
          setState('RUNNING');
        },
      });
    });

    // Session update listener
    const unsubscribeUpdates = client.onSessionUpdate((notif: any) => {
      const update = notif?.update || notif;
      const updateType = notif?.updateType || update?.sessionUpdate || update?.updateType || notif?.sessionUpdate;
      const data = notif?.data || update?.data || update;
      const content = notif?.content || update?.content;

      // State Changed
      if (updateType === 'state_changed') {
        const newState = (data?.state || 'IDLE').toUpperCase() as AgentRuntimeState;
        setState(newState);

        if (data?.report) {
          setStats((prev) => ({
            ...prev,
            totalTokens: data.report.totalTokens ?? prev.totalTokens,
            promptTokens: data.report.totalPromptTokens ?? prev.promptTokens,
            completionTokens: data.report.totalCompletionTokens ?? prev.completionTokens,
            toolCallsCount: data.report.totalToolCalls ?? prev.toolCallsCount,
          }));
        }
      }

      // Plan Generated
      if (updateType === 'plan_generated' && data?.milestones) {
        setPlan({
          goal: data.goal || 'Execution Plan',
          milestones: data.milestones.map((m: any) => ({
            id: m.id,
            title: m.title,
            description: m.description,
            status: m.status || 'pending',
          })),
        });
      }

      // Milestone Updated
      if (updateType === 'milestone_updated' && data?.milestoneId) {
        setPlan((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            milestones: prev.milestones.map((m) =>
              m.id === data.milestoneId ? { ...m, status: data.status } : m
            ),
          };
        });
      }

      // Thought chunk
      if (updateType === 'agent_thought_chunk' || notif?.sessionUpdate === 'agent_thought_chunk' || update?.sessionUpdate === 'agent_thought_chunk') {
        const delta = data?.text || (typeof content === 'string' ? content : content?.text) || '';
        if (delta) {
          setMessages((prev) => {
            if (currentThoughtMessageId.current) {
              return prev.map((m) =>
                m.id === currentThoughtMessageId.current
                  ? { ...m, content: (m.content || '') + delta }
                  : m
              );
            }
            const newId = `thought_${Date.now()}`;
            currentThoughtMessageId.current = newId;
            return [
              ...prev,
              {
                id: newId,
                type: 'thought',
                content: delta,
                timestamp: Date.now(),
              },
            ];
          });
        }
      }

      // Message chunk (Agent speech)
      if (updateType === 'agent_message_chunk' || notif?.sessionUpdate === 'agent_message_chunk' || update?.sessionUpdate === 'agent_message_chunk') {
        const delta = data?.text || (typeof content === 'string' ? content : content?.text) || '';
        if (delta) {
          // Reset thought cursor since agent has moved to speech
          currentThoughtMessageId.current = null;

          setMessages((prev) => {
            if (currentAgentMessageId.current) {
              return prev.map((m) =>
                m.id === currentAgentMessageId.current
                  ? { ...m, content: (m.content || '') + delta }
                  : m
              );
            }
            const newId = `agent_${Date.now()}`;
            currentAgentMessageId.current = newId;
            return [
              ...prev,
              {
                id: newId,
                type: 'agent',
                content: delta,
                timestamp: Date.now(),
              },
            ];
          });
        }
      }

      // Step started (Tool execution)
      if (updateType === 'step_started' && (data?.toolName || data?.stepType === 'TOOL_EXECUTION')) {
        currentAgentMessageId.current = null;
        currentThoughtMessageId.current = null;

        const toolId = data.stepId || `tool_${Date.now()}`;
        const toolCall: UIToolCall = {
          id: toolId,
          name: data.toolName || 'tool',
          argsSummary: data.metadata?.args ? JSON.stringify(data.metadata.args) : '',
          status: 'running',
          startedAt: Date.now(),
        };

        activeToolCalls.current.set(toolId, toolCall);
        setStats((prev) => ({ ...prev, toolCallsCount: prev.toolCallsCount + 1 }));

        setMessages((prev) => [
          ...prev,
          {
            id: `msg_${toolId}`,
            type: 'tool',
            toolCall,
            timestamp: Date.now(),
          },
        ]);
      }

      // Step finished (Tool execution)
      if (updateType === 'step_finished' && data?.stepId) {
        const existing = activeToolCalls.current.get(data.stepId);
        if (existing) {
          const updated: UIToolCall = {
            ...existing,
            status: data.status === 'SUCCESS' ? 'completed' : 'failed',
            durationMs: Date.now() - existing.startedAt,
            outputPreview: data.metadata?.resultPreview || data.payload?.summary || (data.errorMessage ? undefined : 'Success'),
            errorMessage: data.errorMessage,
          };
          activeToolCalls.current.delete(data.stepId);

          setMessages((prev) =>
            prev.map((m) =>
              m.toolCall?.id === data.stepId ? { ...m, toolCall: updated } : m
            )
          );
        }

        if (data.tokens?.totalTokens) {
          setStats((prev) => ({
            ...prev,
            totalTokens: prev.totalTokens + (data.tokens.totalTokens || 0),
          }));
        }
      }
    });

    return () => {
      unsubscribePermission();
      unsubscribeUpdates();
    };
  }, [client]);

  // 3. Smart 2-stage Ctrl+C & Esc handling
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (state === 'RUNNING') {
        // Cancel ongoing task
        client.cancelSession(sessionId, 'User requested cancellation').catch(() => {});
        setState('IDLE');
        setMessages((prev) => [
          ...prev,
          {
            id: `sys_${Date.now()}`,
            type: 'system',
            content: '⚠️ 当前任务已被用户中断 (Ctrl+C)',
            timestamp: Date.now(),
          },
        ]);
      } else {
        // Idle: exit TUI
        handleExit();
      }
      return;
    }

    if (key.escape) {
      if (pendingApproval) {
        pendingApproval.respond('rejected', 'Cancelled by user via Escape key');
        setPendingApproval(undefined);
        setState('RUNNING');
      }
    }
  }, { isActive: Boolean(process.stdin.isTTY) });

  const handleExit = () => {
    if (onExit) onExit();
    exit();
  };

  // 4. Input & Slash command execution
  const handleSubmit = async (text: string) => {
    if (text.startsWith('/')) {
      const parts = text.split(' ');
      const cmd = parts[0].toLowerCase();

      switch (cmd) {
        case '/help':
          setMessages((prev) => [
            ...prev,
            {
              id: `sys_${Date.now()}`,
              type: 'system',
              content:
                '📖 可用命令与快捷键说明:\n' +
                '  /help     - 显示本帮助信息\n' +
                '  /sessions - 查看历史会话列表\n' +
                '  /resume   - 切换/恢复历史会话 (/resume <sessionId>)\n' +
                '  /clear    - 清空屏幕历史消息流\n' +
                '  /status   - 显示当前会话状态、Token 消耗与耗时\n' +
                '  /exit     - 退出 TUI 终端界面\n' +
                '  Ctrl+C    - 任务运行中中断任务 / 空闲状态退出程序\n' +
                '  Esc       - 关闭/拒绝当前的权限审批弹框',
              timestamp: Date.now(),
            },
          ]);
          return;

        case '/sessions': {
          try {
            const listRes = await client.listSessions({ cwd: workspacePath });
            const items = listRes.sessions || [];
            if (items.length === 0) {
              setMessages((prev) => [
                ...prev,
                {
                  id: `sys_${Date.now()}`,
                  type: 'system',
                  content: '当前工作区暂无历史会话。',
                  timestamp: Date.now(),
                },
              ]);
            } else {
              const formatted = items.slice(0, 10).map((s, idx) =>
                `  ${idx + 1}. [${s.sessionId}] (${new Date(s.updatedAt || Date.now()).toLocaleString()}) ${s.title || ''}`
              ).join('\n');
              setMessages((prev) => [
                ...prev,
                {
                  id: `sys_${Date.now()}`,
                  type: 'system',
                  content: `📋 最近历史会话列表 (输入 /resume <sessionId> 恢复切入):\n${formatted}`,
                  timestamp: Date.now(),
                },
              ]);
            }
          } catch (err: any) {
            setMessages((prev) => [
              ...prev,
              {
                id: `sys_${Date.now()}`,
                type: 'system',
                content: `获取会话列表失败: ${err.message}`,
                timestamp: Date.now(),
              },
            ]);
          }
          return;
        }

        case '/resume': {
          const targetId = parts[1]?.trim();
          if (!targetId) {
            setMessages((prev) => [
              ...prev,
              {
                id: `sys_${Date.now()}`,
                type: 'system',
                content: '用法: /resume <sessionId>。可先输入 /sessions 查看历史会话列表。',
                timestamp: Date.now(),
              },
            ]);
            return;
          }
          setMessages((prev) => [
            ...prev,
            {
              id: `sys_${Date.now()}`,
              type: 'system',
              content: `🔄 正在载入并恢复历史会话: ${targetId}...`,
              timestamp: Date.now(),
            },
          ]);
          try {
            setMessages([]);
            await client.loadSession(targetId);
            setCurrentActiveSessionId(targetId);
            setMessages((prev) => [
              ...prev,
              {
                id: `sys_${Date.now()}`,
                type: 'system',
                content: `✅ 已切换至历史会话 [${targetId}]，您可以直接发送后续消息继续对话。`,
                timestamp: Date.now(),
              },
            ]);
          } catch (err: any) {
            setMessages((prev) => [
              ...prev,
              {
                id: `sys_${Date.now()}`,
                type: 'system',
                content: `❌ 载入会话失败: ${err.message}`,
                timestamp: Date.now(),
              },
            ]);
          }
          return;
        }

        case '/clear':
          setMessages([]);
          return;

        case '/status':
          setMessages((prev) => [
            ...prev,
            {
              id: `sys_${Date.now()}`,
              type: 'system',
              content:
                `📊 当前运行状态:\n` +
                `  - 状态: ${state}\n` +
                `  - 会话 ID: ${currentActiveSessionId}\n` +
                `  - 运行耗时: ${stats.elapsedSeconds} 秒\n` +
                `  - 总 Token: ${stats.totalTokens.toLocaleString()}\n` +
                `  - 工具调用: ${stats.toolCallsCount} 次`,
              timestamp: Date.now(),
            },
          ]);
          return;

        case '/exit':
        case '/quit':
          handleExit();
          return;

        default:
          setMessages((prev) => [
            ...prev,
            {
              id: `sys_${Date.now()}`,
              type: 'system',
              content: `未知指令: ${cmd}。输入 /help 查看支持的指令列表。`,
              timestamp: Date.now(),
            },
          ]);
          return;
      }
    }

    // Regular prompt to Agent
    activeToolCalls.current.clear();
    currentAgentMessageId.current = null;
    currentThoughtMessageId.current = null;

    setMessages((prev) => [
      ...prev,
      {
        id: `user_${Date.now()}`,
        type: 'user',
        content: text,
        timestamp: Date.now(),
      },
    ]);

    setState('RUNNING');

    try {
      const result = await client.promptSession(currentActiveSessionId, text);
      if (result.status === 'completed') {
        setState('COMPLETED');
      } else if (result.status === 'blocked' || result.stopReason === 'requires_action') {
        setState('SUSPENDED_INPUT');
        setMessages((prev) => [
          ...prev,
          {
            id: `sys_${Date.now()}`,
            type: 'system',
            content: `⏸ 任务执行挂起: ${result.summary || '等待用户输入下一步指令'}`,
            timestamp: Date.now(),
          },
        ]);
      } else if (result.status === 'error') {
        setState('FAILED');
      }
    } catch (err: any) {
      setState('FAILED');
      setMessages((prev) => [
        ...prev,
        {
          id: `err_${Date.now()}`,
          type: 'system',
          content: `❌ 执行失败: ${err.message || String(err)}`,
          timestamp: Date.now(),
        },
      ]);
    }
  };

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Header
        state={state}
        modelName={modelName}
        workspacePath={workspacePath}
        stats={stats}
      />

      <PlanProgress plan={plan} />

      <MessageStream messages={messages} />

      {pendingApproval && <ApprovalModal approval={pendingApproval} />}

      <InputBar
        state={state}
        hasPendingApproval={Boolean(pendingApproval)}
        onSubmit={handleSubmit}
      />
    </Box>
  );
};
