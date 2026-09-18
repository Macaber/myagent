import * as path from 'node:path';
import { createAgentRuntime } from '../dist/index.js';
import { OpenAIProvider } from '../dist/provider/openai-provider.js';
import { ThreadContext } from '../dist/runtime/thread-context.js';

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.OPENAI_MODEL || 'gpt-4o';

  if (!apiKey) {
    console.error(`\x1b[31m[错误] 未检测到 OPENAI_API_KEY 环境变量！\x1b[0m\n`);
    console.log(`请先设置模型 API 密钥与地址（兼容 OpenAI / DeepSeek / 通义千问 / Ollama 等）：`);
    console.log(`\x1b[36mexport OPENAI_API_KEY="sk-xxxxxxxxxxxxxxxx"\x1b[0m`);
    console.log(`\x1b[36mexport OPENAI_BASE_URL="https://api.openai.com/v1"\x1b[0m  # 例如 DeepSeek 可填 https://api.deepseek.com/v1`);
    console.log(`\x1b[36mexport OPENAI_MODEL="gpt-4o"\x1b[0m                      # 例如 deepseek-chat, qwen-plus 等\n`);
    console.log(`然后重新运行：`);
    console.log(`npm run task "请分析当前项目结构并写一份总结到 docs/summary.md"`);
    process.exit(1);
  }

  const userPrompt = process.argv.slice(2).join(' ').trim() ||
    '分析当前项目的目录结构，并在 docs/project_overview.md 中编写一份清晰的模块概览。';

  console.log(`\x1b[32m========================================================\x1b[0m`);
  console.log(`\x1b[32m  MyAgent 长任务 Agent 运行时 - 实机测试控制台\x1b[0m`);
  console.log(`\x1b[32m========================================================\x1b[0m`);
  console.log(`- Base URL:  \x1b[33m${baseUrl}\x1b[0m`);
  console.log(`- Model:     \x1b[33m${model}\x1b[0m`);
  console.log(`- Task Goal: \x1b[36m${userPrompt}\x1b[0m`);
  console.log(`--------------------------------------------------------\n`);

  const provider = new OpenAIProvider({
    apiKey,
    baseUrl,
    model,
  });

  const workspaceRoot = process.cwd();
  const runtime = createAgentRuntime({
    workspaceRoot,
    dbPath: path.join(workspaceRoot, '.agent', 'data.db'),
    provider,
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
    console.log(`- 总 Token:    ${report.totalTokens} (Prompt: ${report.totalPromptTokens}, Completion: ${report.totalCompletionTokens})`);
    console.log(`- 工具调用:    ${report.totalToolCalls} 次`);
    console.log(`- 阶段明细:`);
    for (const [turnType, turn] of Object.entries(report.byTurnType)) {
      console.log(`    • [${turnType.padEnd(12)}] 耗时: ${String(turn.durationMs).padStart(5)}ms | Tokens: ${String(turn.tokens).padStart(6)} | 调用: ${turn.count}次`);
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
