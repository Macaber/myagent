import * as path from 'node:path';
import { createAgentRuntime, resolveDefaultProvider } from '../dist/index.js';
import { ThreadContext } from '../dist/runtime/thread-context.js';
import { AcpClient } from '../dist/client/acp-client.js';
import { createMemoryTransportPair } from '../dist/client/memory-transport.js';

async function main() {
  const projectRoot = process.cwd();
  const provider = resolveDefaultProvider(projectRoot);

  if (!provider) {
    console.error('[Error] No LLM provider found.');
    process.exit(1);
  }

  console.log(`\n\x1b[34m================================================================================\x1b[0m`);
  console.log(`\x1b[34m          Claude Code 风格多 Explore 子智能体并发架构调研实机评测               \x1b[0m`);
  console.log(`\x1b[34m================================================================================\x1b[0m`);
  console.log(`- 评测模型: \x1b[33m${provider.getModel()}\x1b[0m`);
  console.log(`- 工作区:   \x1b[90m${projectRoot}\x1b[0m\n`);

  const { clientTransport, serverTransport } = createMemoryTransportPair();
  const dbPath = path.join(projectRoot, '.agent', 'multiagent.db');

  const runtime = createAgentRuntime({
    workspaceRoot: projectRoot,
    dbPath,
    transport: serverTransport,
    provider,
  });

  const client = new AcpClient(clientTransport);
  client.onRequestPermission((_, respond) => respond('approved_once'));

  const prompt =
    '请分析项目架构。为避免上下文膨胀并加速调研，请使用 invoke_subagent 并发派发 2 个 explore 子 agent 执行：\n' +
    '子任务 1: role="explore", taskDescription="阅读调研 src/security 目录，总结 WorkspaceJail 与 PolicyEngine 的核心机制"\n' +
    '子任务 2: role="explore", taskDescription="阅读调研 src/protocol 目录，总结 ACP 协议与 RpcDispatcher 的核心机制"\n' +
    '子 agent 执行完成后，请汇总两者事实，输出清晰的全局架构分析总结。';

  const threadId = `multi_explore_${Date.now()}`;
  const thread = new ThreadContext(
    {
      threadId,
      sessionId: `sess_${Date.now()}`,
      prompt,
      workspacePath: projectRoot,
    },
    runtime.db,
    runtime.dispatcher
  );

  runtime.activeThreads.set(threadId, thread);

  const start = Date.now();
  try {
    console.log('\x1b[35m▶ 主 Agent 启动并正在调度并发子 Agent...\x1b[0m\n');
    const report = await runtime.runner.runTask(thread);
    const durationSec = ((Date.now() - start) / 1000).toFixed(1);

    console.log(`\n\x1b[32m✔ 任务完成！总耗时: ${durationSec} 秒 | 消耗 Token: ${report.totalTokens?.totalTokens?.toLocaleString() || 0}\x1b[0m\n`);

    // 查询 SQLite 确认派生子线程
    const rawDb = runtime.db.getRawDb();
    const childRows = rawDb.prepare('SELECT thread_id, prompt, total_tokens FROM threads WHERE parent_thread_id = ?').all(threadId) as any[];

    console.log(`\x1b[36m📊 并发子线程遥测追踪 (派生子 Agent 数量: ${childRows.length}):\x1b[0m`);
    for (const c of childRows) {
      console.log(`  - 子线程: ${c.thread_id} | Token: ${c.total_tokens} | 目标: ${c.prompt}`);
    }

    const workerTurn = report.turnsBreakdown?.find((t) => t.turnType === 'WORKER');
    console.log(`\n\x1b[32m📝 主 Agent 全局汇总输出:\x1b[0m\n`);
    console.log(workerTurn?.summary || report.prompt);

  } finally {
    runtime.db.close();
  }
}

main().catch(console.error);
