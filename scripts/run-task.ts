import * as path from 'node:path';
import * as readline from 'node:readline';
import { createAgentRuntime, resolveDefaultProvider } from '../dist/index.js';
import { OpenAIProvider } from '../dist/provider/openai-provider.js';
import { ThreadContext } from '../dist/runtime/thread-context.js';
import { AcpClient } from '../dist/client/acp-client.js';
import { createMemoryTransportPair } from '../dist/client/memory-transport.js';

async function main() {
  const workspaceRoot = process.cwd();
  let provider: OpenAIProvider | undefined;

  if (process.env.OPENAI_API_KEY) {
    provider = new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: process.env.OPENAI_MODEL || 'gpt-4o',
    });
  } else {
    provider = resolveDefaultProvider(workspaceRoot);
  }

  if (!provider) {
    console.error(`\x1b[31m[错误] 未检测到 OPENAI_API_KEY 环境变量或有效的 API 密钥！\x1b[0m\n`);
    console.log(`请先设置模型 API 密钥与地址（兼容 OpenAI / DeepSeek / 通义千问 / Ollama 等）：`);
    console.log(`\x1b[36mexport OPENAI_API_KEY="sk-xxxxxxxxxxxxxxxx"\x1b[0m`);
    console.log(`\x1b[36mexport OPENAI_BASE_URL="https://api.openai.com/v1"\x1b[0m  # 例如 DeepSeek 可填 https://api.deepseek.com/v1`);
    console.log(`\x1b[36mexport OPENAI_MODEL="gpt-4o"\x1b[0m                      # 例如 deepseek-chat, qwen-plus 等\n`);
    console.log(`或者在项目根目录下配置 .env 文件。`);
    process.exit(1);
  }

  const autoApprove = process.argv.includes('--auto-approve') || process.env.AUTO_APPROVE === 'true';
  const cleanArgs = process.argv.slice(2).filter((arg) => arg !== '--auto-approve');
  const userPrompt = cleanArgs.join(' ').trim() ||
    '分析当前项目的目录结构，并在 docs/project_overview.md 中编写一份清晰的模块概览。';

  console.log(`\x1b[32m========================================================\x1b[0m`);
  console.log(`\x1b[32m  MyAgent 长任务 Agent 运行时 - 实机测试控制台\x1b[0m`);
  console.log(`\x1b[32m========================================================\x1b[0m`);
  console.log(`- Model:        \x1b[33m${provider.getModel()}\x1b[0m`);
  console.log(`- Auto-Approve: \x1b[33m${autoApprove ? '启用 (YES)' : '关闭 (需交互式确认)'}\x1b[0m`);
  console.log(`- Task Goal:    \x1b[36m${userPrompt}\x1b[0m`);
  console.log(`--------------------------------------------------------\n`);

  const { clientTransport, serverTransport } = createMemoryTransportPair();

  const runtime = createAgentRuntime({
    workspaceRoot,
    dbPath: path.join(workspaceRoot, '.agent', 'data.db'),
    transport: serverTransport,
    provider,
  });

  const client = new AcpClient(clientTransport);

  // Subscribe to live session updates for formatted terminal display
  client.onSessionUpdate((notif: any) => {
    const update = notif?.update || notif;
    const updateType = notif?.updateType || update?.sessionUpdate || update?.updateType;
    const content = notif?.content || update?.content;
    const text = typeof content === 'string' ? content : content?.text || '';

    if (updateType === 'agent_message_chunk' && text) {
      process.stdout.write(`\x1b[32m${text}\x1b[0m`);
    } else if (updateType === 'tool_call' && update?.title) {
      console.log(`\n\x1b[36m⚙️  [工具调用] ${update.title} ${update.rawInput ? JSON.stringify(update.rawInput) : ''}\x1b[0m`);
    } else if (updateType === 'tool_call_update' && update?.status) {
      console.log(`\x1b[90m   ↳ [执行完成] 状态: ${update.status}\x1b[0m`);
    }
  });

  // Handle HITL permissions in CLI
  client.onRequestPermission((req, respond) => {
    if (autoApprove) {
      console.log(`\n\x1b[33m⚡ [自动审批通过] 工具 '${req.toolCall?.name}': ${req.description}\x1b[0m\n`);
      respond('approved_once');
      return;
    }

    if (process.stdin.isTTY) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      console.log(`\n\x1b[31m⚠️  [HITL 权限审批拦截]: 工具 '${req.toolCall?.name}' (${req.riskLevel})\x1b[0m`);
      console.log(`   描述: ${req.description}`);
      rl.question('   是否允许执行该操作? (y/n, 默认 n): ', (answer) => {
        rl.close();
        if (answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes') {
          console.log('\x1b[32m   [已批准执行]\x1b[0m\n');
          respond('approved_once');
        } else {
          console.log('\x1b[31m   [已拒绝执行]\x1b[0m\n');
          respond('rejected', 'User rejected operation in CLI');
        }
      });
    } else {
      console.warn(`\n\x1b[31m[审批拦截] 非交互式运行环境且未启用 --auto-approve，自动拒绝高风险工具 '${req.toolCall?.name}'\x1b[0m\n`);
      respond('rejected', 'Non-interactive environment without auto-approve');
    }
  });

  const threadId = `task_${Date.now()}`;
  const thread = new ThreadContext(
    {
      threadId,
      sessionId: `session_${Date.now()}`,
      prompt: userPrompt,
      workspacePath: workspaceRoot,
    },
    runtime.db,
    runtime.dispatcher
  );

  runtime.activeThreads.set(threadId, thread);

  console.log(`[Runtime] 正在启动任务编排与执行...\n`);

  try {
    const report = await runtime.runner.runTask(thread);

    console.log(`\n\x1b[32m========================================================\x1b[0m`);
    console.log(`\x1b[32m  任务执行完毕！状态: ${report.status}\x1b[0m`);
    console.log(`\x1b[32m========================================================\x1b[0m`);
    console.log(`- 总耗时:      ${report.totalDurationMs} ms`);
    console.log(`- 总 Token:    ${report.totalTokens?.totalTokens ?? 0} (Prompt: ${report.totalTokens?.promptTokens ?? 0}, Completion: ${report.totalTokens?.completionTokens ?? 0})`);
    console.log(`- 工具调用:    ${report.counts?.toolCalls ?? 0} 次`);
    console.log(`- 阶段明细:`);
    if (report.turnsBreakdown) {
      for (const turn of report.turnsBreakdown) {
        console.log(`    • [${turn.turnType.padEnd(12)}] 耗时: ${String(turn.durationMs).padStart(5)}ms | Tokens: ${String(turn.tokens?.totalTokens ?? 0).padStart(6)} | Steps: ${turn.stepCount}`);
      }
    }

    const modifiedFiles = thread.blackboard.getModifiedFiles();
    if (modifiedFiles.length > 0) {
      console.log(`- 产生变更的文件 (${modifiedFiles.length}):`);
      for (const f of modifiedFiles) {
        console.log(`    ✓ ${f}`);
      }
    }

    console.log(`\n- 持久化数据库: .agent/data.db`);
    console.log(`- 执行分析报表: .agent/tasks/${threadId}/metrics_summary.json\n`);
  } catch (err: any) {
    console.error(`\n\x1b[31m[执行失败] ${err.message}\x1b[0m`);
    if (err.stack) console.error(err.stack);
  } finally {
    runtime.db.close();
  }
}

main().catch(console.error);
