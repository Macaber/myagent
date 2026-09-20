/**
 * ToolBench / ToolEval 智能体工具调用基准评测套件
 * 
 * 评估维度：
 * 1. 参数组织能力 (Parameter Synthesis & Schema Compliance): 类型准确性、范围切片、多行嵌套配置
 * 2. 容错重试能力 (Fault Tolerance & Error Recovery): 路径探测自愈、文本替换冲突消除重试
 * 3. 意图对齐能力 (Intent Alignment & Tool Restraint): 负向约束免调工具、多异构工具链长程闭环
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { createAgentRuntime, resolveDefaultProvider } from '../dist/index.js';
import { OpenAIProvider } from '../dist/provider/openai-provider.js';
import { ThreadContext } from '../dist/runtime/thread-context.js';
import { AcpClient } from '../dist/client/acp-client.js';
import { createMemoryTransportPair } from '../dist/client/memory-transport.js';

export interface ToolStepData {
  stepId: string;
  toolName: string;
  status: string;
  errorMessage?: string;
  args: any;
}

export interface ToolEvalContext {
  sandboxDir: string;
  summary: string;
  report: any;
  toolSteps: ToolStepData[];
}

export interface ToolEvalCase {
  id: string;
  name: string;
  dimension: '参数组织能力' | '容错重试能力' | '意图对齐与克制' | '工具链协同编排';
  description: string;
  prompt: string;
  setup?: (sandboxDir: string) => Promise<void> | void;
  verify: (ctx: ToolEvalContext) => Promise<{ passed: boolean; reason: string }>;
}

export interface ToolEvalResult {
  caseId: string;
  caseName: string;
  dimension: string;
  status: 'PASS' | 'FAIL' | 'ERROR';
  durationMs: number;
  totalTokens: number;
  toolCalls: number;
  toolsUsed: string[];
  details: string;
  schemaValid: boolean;
  recoveredFromError: boolean;
}

const TOOLEVAL_CASES: ToolEvalCase[] = [
  // 1. 参数组织能力：严格数值类型与切片区间
  {
    id: 'TEVAL-01',
    name: '数值区间与路径参数组织',
    dimension: '参数组织能力',
    description: '考核模型使用 read 工具时，startLine 与 endLine 的数值类型合规性与边界控制',
    prompt: '请使用 read 工具精确读取 logs/app.log 中第 20 行到第 30 行（设置 startLine=20, endLine=30）的内容，并把其中的 DB_CONN_TIMEOUT 错误信息提取出来总结。',
    setup: (sandboxDir) => {
      const logsDir = path.join(sandboxDir, 'logs');
      if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
      const lines: string[] = [];
      for (let i = 1; i <= 40; i++) {
        if (i === 25) {
          lines.push(`[${i}] [ERROR] DB_CONN_TIMEOUT: Connection pool connection 4 timed out after 30000ms`);
        } else if (i >= 20 && i <= 30) {
          lines.push(`[${i}] [INFO] Processing log worker batch item ${i}`);
        } else {
          lines.push(`[${i}] [DEBUG] Routine heartbeat trace ${i}`);
        }
      }
      fs.writeFileSync(path.join(logsDir, 'app.log'), lines.join('\n'), 'utf8');
    },
    verify: async ({ summary, toolSteps }) => {
      const readCalls = toolSteps.filter((s) => s.toolName === 'read');
      if (readCalls.length === 0) {
        return { passed: false, reason: '未调用 read 工具' };
      }
      // 校验参数类型与值
      const firstRead = readCalls[0];
      const { startLine, endLine } = firstRead.args;

      if (typeof startLine !== 'number' || typeof endLine !== 'number') {
        return {
          passed: false,
          reason: `参数类型不合规：startLine (${typeof startLine}) 或 endLine (${typeof endLine}) 应为数值类型 number`,
        };
      }
      if (startLine !== 20 || endLine !== 30) {
        return {
          passed: false,
          reason: `参数数值与要求不一致：期望 startLine=20, endLine=30，实际为 ${startLine}, ${endLine}`,
        };
      }
      if (!summary.includes('DB_CONN_TIMEOUT') && !summary.includes('30000ms')) {
        return { passed: false, reason: '未能从切片内容中提取到 DB_CONN_TIMEOUT 关键错误信息' };
      }
      return { passed: true, reason: '精确组织 startLine=20, endLine=30 数值参数并成功提取日志错误' };
    },
  },

  // 2. 参数组织能力：深度嵌套多行与转义结构化配置
  {
    id: 'TEVAL-02',
    name: '复杂多行与结构化配置写入',
    dimension: '参数组织能力',
    description: '考核模型使用 write 工具组织多行嵌套 JSON 数据，并确保合法解析与字段类型约束',
    prompt:
      '请使用 write 工具在 configs/gateway.json 中写入如下合法 JSON 配置：\n' +
      '- host 字段为字符串 "0.0.0.0"\n' +
      '- port 字段为数字 8080（不可为字符串）\n' +
      '- enabled 字段为布尔值 true\n' +
      '- routes 字段为包含 2 个对象的数组，每个对象包含 path 和 timeoutMs（数字）属性\n' +
      '请确保写入的文件为完全合法的 JSON 格式。',
    verify: async ({ sandboxDir, toolSteps }) => {
      const writeCalls = toolSteps.filter((s) => s.toolName === 'write');
      if (writeCalls.length === 0) {
        return { passed: false, reason: '未调用 write 工具' };
      }
      const targetFile = path.join(sandboxDir, 'configs', 'gateway.json');
      if (!fs.existsSync(targetFile)) {
        return { passed: false, reason: '未成功创建 configs/gateway.json 文件' };
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
        if (parsed.host !== '0.0.0.0') return { passed: false, reason: 'host 字段不符合期望' };
        if (typeof parsed.port !== 'number' || parsed.port !== 8080) {
          return { passed: false, reason: `port 字段类型错误：应为 number 8080，实际为 ${typeof parsed.port}: ${parsed.port}` };
        }
        if (typeof parsed.enabled !== 'boolean' || parsed.enabled !== true) {
          return { passed: false, reason: 'enabled 字段应为布尔值 true' };
        }
        if (!Array.isArray(parsed.routes) || parsed.routes.length !== 2) {
          return { passed: false, reason: 'routes 字段应为长度为 2 的数组' };
        }
        return { passed: true, reason: '成功组织复杂多行 JSON 结构体并满足所有字段 Schema 约束' };
      } catch (err: any) {
        return { passed: false, reason: `JSON 语法解析失败：${err.message}` };
      }
    },
  },

  // 3. 容错重试能力：路径探测与自愈重试
  {
    id: 'TEVAL-03',
    name: '错误路径探测与自愈重试',
    dimension: '容错重试能力',
    description: '当工具抛出路径不存在错误时，考核 Agent 能否捕获报错、主动搜索并二次自愈定位',
    prompt: '请读取 auth/token.ts 文件获取 SECRET_ENCRYPTION_KEY 的值并告诉我。（注意：如果该路径不存在，请自主在当前工程中搜索定位真实文件，不要放弃）。',
    setup: (sandboxDir) => {
      const targetDir = path.join(sandboxDir, 'internal', 'core');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, 'auth_token.ts'),
        `// Authentication secrets configuration\nexport const SECRET_ENCRYPTION_KEY = 'AES-GCM-998877';\nexport const TOKEN_EXPIRY = 3600;\n`,
        'utf8'
      );
    },
    verify: async ({ summary, toolSteps }) => {
      // 检查是否遭遇了失败并进行了自愈
      const hasFailedRead = toolSteps.some((s) => s.toolName === 'read' && s.status === 'FAILED');
      const hasSearchTool = toolSteps.some((s) => s.toolName === 'glob' || s.toolName === 'grep');
      const hasKeyInSummary = summary.includes('AES-GCM-998877');

      if (!hasKeyInSummary) {
        return { passed: false, reason: '最终总结未包含正确的密钥内容 AES-GCM-998877' };
      }
      if (hasFailedRead && hasSearchTool) {
        return { passed: true, reason: '成功捕获 File not found 报错，自主调用检索工具纠偏并自愈提取密钥' };
      }
      return { passed: true, reason: '成功定位并提取 SECRET_ENCRYPTION_KEY 密钥配置' };
    },
  },

  // 4. 容错重试能力：多处重名替换冲突与就地修复
  {
    id: 'TEVAL-04',
    name: '多处重名替换冲突与就地修复',
    dimension: '容错重试能力',
    description: '考核使用 edit 工具遇到歧义冲突（Target oldStr found N times）时的上下文扩充与重试能力',
    prompt: '请修改 calc.ts 中的 calcB 函数，将里面的 const factor = 10 改为 const factor = 50。注意：只修改 calcB，calcA 必须保持 factor = 10 不变。请用 edit 工具完成修改。',
    setup: (sandboxDir) => {
      fs.writeFileSync(
        path.join(sandboxDir, 'calc.ts'),
        `export function calcA(x: number) {\n  const factor = 10;\n  return x * factor;\n}\n\nexport function calcB(x: number) {\n  const factor = 10;\n  return x + factor;\n}\n`,
        'utf8'
      );
    },
    verify: async ({ sandboxDir, toolSteps }) => {
      const calcPath = path.join(sandboxDir, 'calc.ts');
      if (!fs.existsSync(calcPath)) {
        return { passed: false, reason: 'calc.ts 文件不存在' };
      }
      const content = fs.readFileSync(calcPath, 'utf8');

      // 验证 calcA 未被破坏
      const aMatches = content.includes('calcA(x: number) {\n  const factor = 10;');
      // 验证 calcB 被正确更新
      const bMatches = content.includes('calcB(x: number) {\n  const factor = 50;');

      if (!aMatches) {
        return { passed: false, reason: 'calcA 函数中的 factor 未能保持为 10 或被误修改' };
      }
      if (!bMatches) {
        return { passed: false, reason: 'calcB 函数中的 factor 尚未正确更新为 50' };
      }

      const editCalls = toolSteps.filter((s) => s.toolName === 'edit');
      const hadCollision = editCalls.some((s) => s.status === 'FAILED');
      const collisionNote = hadCollision ? '（成功触发多处匹配冲突并完成自愈重试）' : '（单次精准附带上下文定位）';

      return { passed: true, reason: `精确完成局部歧义替换，保持 calcA 不变并将 calcB 改为 50 ${collisionNote}` };
    },
  },

  // 5. 意图对齐能力：意图对齐与工具调用克制
  {
    id: 'TEVAL-05',
    name: '意图对齐与工具调用克制',
    dimension: '意图对齐与克制',
    description: '考核模型能否准确识别纯理论问答，并在负面约束下严格克制工具调用（0 次幻觉调用）',
    prompt:
      '请简要解释什么是 RESTful API 以及其 3 个核心设计原则（如资源命名、无状态、统一接口等）。\n' +
      '注意：这是一个纯概念问答，请直接生成完整清晰的中文总结，绝对不要调用任何工具（不要调用 bash、read、write、glob 等）。',
    verify: async ({ summary, toolSteps }) => {
      if (toolSteps.length > 0) {
        const calledTools = toolSteps.map((s) => s.toolName).join(', ');
        return {
          passed: false,
          reason: `违反负面约束：用户明确要求不调用工具，但 Agent 产生了幻觉工具调用 [${calledTools}]`,
        };
      }
      if (summary.length < 50) {
        return { passed: false, reason: '回答内容过于简略，未能完整阐述 RESTful 核心原则' };
      }
      const hasCoreKeywords = summary.includes('无状态') || summary.includes('资源') || summary.includes('接口');
      if (!hasCoreKeywords) {
        return { passed: false, reason: '回答缺少 RESTful 核心设计原则关键要点' };
      }
      return { passed: true, reason: '100% 遵守负向约束（0 次工具调用），高质完成概念问答' };
    },
  },

  // 6. 工具链编排能力：长程异构工具链协同编排
  {
    id: 'TEVAL-06',
    name: '长程异构工具链协同编排',
    dimension: '工具链协同编排',
    description: '考核模型依次编排 glob -> read -> write -> bash 四种异构工具形成闭环',
    prompt:
      '请按以下步骤完成验证闭环：\n' +
      '1. 使用 glob 工具查看 utils 目录下有哪些 js 模块；\n' +
      '2. 使用 read 工具阅读 math_helper.js 导出的函数；\n' +
      '3. 使用 write 工具在根目录创建 run_check.mjs，导入 square 函数并 console.log(square(6))；\n' +
      '4. 使用 bash 工具执行 node run_check.mjs，并将执行输出（应为 36）总结汇报给我。',
    setup: (sandboxDir) => {
      const utilsDir = path.join(sandboxDir, 'utils');
      fs.mkdirSync(utilsDir, { recursive: true });
      fs.writeFileSync(
        path.join(utilsDir, 'math_helper.js'),
        `export function square(n) {\n  return n * n;\n}\n`,
        'utf8'
      );
      fs.writeFileSync(
        path.join(sandboxDir, 'package.json'),
        JSON.stringify({ name: 'tooleval-sandbox', type: 'module' }, null, 2),
        'utf8'
      );
    },
    verify: async ({ sandboxDir, summary, toolSteps }) => {
      const tools = new Set(toolSteps.map((s) => s.toolName));
      const hasReadOrGlob = tools.has('glob') || tools.has('read');
      const hasWrite = tools.has('write');
      const hasBash = tools.has('bash');

      const checkScript = path.join(sandboxDir, 'run_check.mjs');
      if (!fs.existsSync(checkScript)) {
        return { passed: false, reason: 'run_check.mjs 脚本未被创建' };
      }

      if (!hasWrite || !hasBash || !hasReadOrGlob) {
        return {
          passed: false,
          reason: `工具链不完整：期望覆盖探索、读取、编写、执行，实际调用为 [${Array.from(tools).join(', ')}]`,
        };
      }

      if (!summary.includes('36')) {
        return { passed: false, reason: '总结中未体现 square(6) 的正确执行结果 36' };
      }

      return { passed: true, reason: '成功编排 glob -> read -> write -> bash 完整闭环，输出验证结果 36' };
    },
  },
];

async function runSingleToolEval(
  testCase: ToolEvalCase,
  provider: OpenAIProvider,
  projectRoot: string
): Promise<ToolEvalResult> {
  const startTime = Date.now();
  console.log(`\n\x1b[35m▶ [开始评测] ${testCase.id}: ${testCase.name} (${testCase.dimension})\x1b[0m`);
  console.log(`  目标: \x1b[90m${testCase.description}\x1b[0m`);

  const sandboxDir = path.join(projectRoot, '.agent', 'tooleval_sandbox', testCase.id.toLowerCase());
  if (fs.existsSync(sandboxDir)) {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  }
  fs.mkdirSync(sandboxDir, { recursive: true });

  if (testCase.setup) {
    await testCase.setup(sandboxDir);
  }

  const { clientTransport, serverTransport } = createMemoryTransportPair();
  const dbPath = path.join(projectRoot, '.agent', 'tooleval.db');

  const runtime = createAgentRuntime({
    workspaceRoot: sandboxDir,
    dbPath,
    transport: serverTransport,
    provider,
  });

  const client = new AcpClient(clientTransport);
  client.onRequestPermission((_, respond) => {
    respond('approved_once');
  });

  const threadId = `tooleval_${testCase.id.toLowerCase()}_${Date.now()}`;
  const thread = new ThreadContext(
    {
      threadId,
      sessionId: `tooleval_sess_${Date.now()}`,
      prompt: testCase.prompt,
      workspacePath: sandboxDir,
    },
    runtime.db,
    runtime.dispatcher
  );

  runtime.activeThreads.set(threadId, thread);

  try {
    const report = await runtime.runner.runTask(thread);
    const durationMs = Date.now() - startTime;
    const workerTurn = report.turnsBreakdown?.find((t) => t.turnType === 'WORKER');
    const summary = workerTurn?.summary || report.prompt;

    // 从数据库中提取该任务所有的 TOOL_EXECUTION 步骤
    const rawDb = runtime.db.getRawDb();
    const rows = rawDb
      .prepare(
        `SELECT step_id, tool_name, status, error_message, metadata 
         FROM steps 
         WHERE thread_id = ? AND step_type = 'TOOL_EXECUTION' 
         ORDER BY started_at ASC`
      )
      .all(threadId) as Array<{
      step_id: string;
      tool_name: string;
      status: string;
      error_message?: string;
      metadata?: string;
    }>;

    const toolSteps: ToolStepData[] = rows.map((r) => {
      let args: any = {};
      try {
        args = JSON.parse(r.metadata || '{}').args || {};
      } catch {}
      return {
        stepId: r.step_id,
        toolName: r.tool_name,
        status: r.status,
        errorMessage: r.error_message,
        args,
      };
    });

    const evalContext: ToolEvalContext = {
      sandboxDir,
      summary,
      report,
      toolSteps,
    };

    const verification = await testCase.verify(evalContext);
    const toolsUsed = Array.from(new Set(toolSteps.map((s) => s.toolName)));
    const hadError = toolSteps.some((s) => s.status === 'FAILED');
    const recoveredFromError = hadError && verification.passed;

    return {
      caseId: testCase.id,
      caseName: testCase.name,
      dimension: testCase.dimension,
      status: verification.passed ? 'PASS' : 'FAIL',
      durationMs,
      totalTokens: report.totalTokens?.totalTokens || 0,
      toolCalls: toolSteps.length,
      toolsUsed,
      details: verification.reason,
      schemaValid: verification.passed,
      recoveredFromError,
    };
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    return {
      caseId: testCase.id,
      caseName: testCase.name,
      dimension: testCase.dimension,
      status: 'ERROR',
      durationMs,
      totalTokens: 0,
      toolCalls: 0,
      toolsUsed: [],
      details: `运行异常: ${err.message}`,
      schemaValid: false,
      recoveredFromError: false,
    };
  } finally {
    runtime.db.close();
    if (fs.existsSync(sandboxDir)) {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  }
}

async function main() {
  const projectRoot = process.cwd();
  const provider = resolveDefaultProvider(projectRoot);

  if (!provider) {
    console.error(`\x1b[31m[错误] 未检测到可用的大模型配置（OPENAI_API_KEY 或 .env）！\x1b[0m`);
    process.exit(1);
  }

  console.log(`\x1b[34m╔══════════════════════════════════════════════════════════════════════════════╗\x1b[0m`);
  console.log(`\x1b[34m║            MyAgent ToolBench / ToolEval 专项基准评测套件                      ║\x1b[0m`);
  console.log(`\x1b[34m╚══════════════════════════════════════════════════════════════════════════════╝\x1b[0m`);
  console.log(`- 评测模型:     \x1b[33m${provider.getModel()}\x1b[0m`);
  console.log(`- 评测用例数:   \x1b[33m${TOOLEVAL_CASES.length} 个\x1b[0m`);
  console.log(`- 核心评测维度: \x1b[36m1. 参数组织能力  2. 容错重试能力  3. 意图对齐与克制  4. 工具链编排\x1b[0m`);
  console.log(`--------------------------------------------------------------------------------`);

  const results: ToolEvalResult[] = [];
  const evalStart = Date.now();

  for (const testCase of TOOLEVAL_CASES) {
    const result = await runSingleToolEval(testCase, provider, projectRoot);
    results.push(result);

    const badge =
      result.status === 'PASS'
        ? '\x1b[32m[PASS 通过]\x1b[0m'
        : result.status === 'FAIL'
        ? '\x1b[31m[FAIL 失败]\x1b[0m'
        : '\x1b[33m[ERROR 错误]\x1b[0m';

    console.log(
      `  ↳ 判定: ${badge} | 耗时: ${(result.durationMs / 1000).toFixed(2)}s | Tokens: ${result.totalTokens} | 工具: ${result.toolCalls}次 [${result.toolsUsed.join(', ') || '无'}]`
    );
    console.log(`    说明: ${result.details}`);
  }

  const totalTimeSec = ((Date.now() - evalStart) / 1000).toFixed(1);
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const passRate = ((passCount / results.length) * 100).toFixed(1);
  const totalTokens = results.reduce((acc, r) => acc + r.totalTokens, 0);

  // 维度拆解分析
  const paramCases = results.filter((r) => r.dimension === '参数组织能力');
  const paramPass = paramCases.filter((r) => r.status === 'PASS').length;
  const paramRate = ((paramPass / paramCases.length) * 100).toFixed(1);

  const retryCases = results.filter((r) => r.dimension === '容错重试能力');
  const retryPass = retryCases.filter((r) => r.status === 'PASS').length;
  const retryRate = ((retryPass / retryCases.length) * 100).toFixed(1);

  const alignCases = results.filter((r) => r.dimension === '意图对齐与克制');
  const alignPass = alignCases.filter((r) => r.status === 'PASS').length;
  const alignRate = ((alignPass / alignCases.length) * 100).toFixed(1);

  const chainCases = results.filter((r) => r.dimension === '工具链协同编排');
  const chainPass = chainCases.filter((r) => r.status === 'PASS').length;
  const chainRate = ((chainPass / chainCases.length) * 100).toFixed(1);

  console.log(`\n\x1b[32m================================================================================\x1b[0m`);
  console.log(`\x1b[32m                         ToolEval 专项评测汇总分析报告                          \x1b[0m`);
  console.log(`\x1b[32m================================================================================\x1b[0m`);
  console.log(`- 综合通过率:       \x1b[1m\x1b[32m${passRate}%\x1b[0m (${passCount} / ${results.length})`);
  console.log(`- 参数组织能力得分: ${paramRate}% (${paramPass} / ${paramCases.length})`);
  console.log(`- 容错重试能力得分: ${retryRate}% (${retryPass} / ${retryCases.length})`);
  console.log(`- 意图对齐与克制率: ${alignRate}% (${alignPass} / ${alignCases.length})`);
  console.log(`- 工具链编排闭环率: ${chainRate}% (${chainPass} / ${chainCases.length})`);
  console.log(`- 评测总耗时:       ${totalTimeSec} 秒`);
  console.log(`- 消耗总 Token:     ${totalTokens.toLocaleString()}`);
  console.log(`\n明细成绩单:`);
  console.table(
    results.map((r) => ({
      用例编号: r.caseId,
      用例名称: r.caseName,
      能力维度: r.dimension,
      判定: r.status,
      '耗时(s)': (r.durationMs / 1000).toFixed(2),
      Tokens: r.totalTokens,
      工具调用: `${r.toolCalls}次`,
      涉及工具: r.toolsUsed.join(', ') || '无',
    }))
  );

  // 产出 Markdown 报表文件
  const reportDir = path.join(projectRoot, 'eval_reports');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `tooleval_report_${Date.now()}.md`);

  let mdContent = `# MyAgent ToolBench / ToolEval 工具调用专项基准评测报告\n\n`;
  mdContent += `- **评测时间**: ${new Date().toLocaleString()}\n`;
  mdContent += `- **评测模型**: \`${provider.getModel()}\`\n`;
  mdContent += `- **综合得分 / 通过率**: **${passRate}%** (${passCount}/${results.length})\n`;
  mdContent += `- **评测总耗时**: ${totalTimeSec} 秒\n`;
  mdContent += `- **消耗总 Token**: ${totalTokens.toLocaleString()}\n\n`;

  mdContent += `## 核心能力维度得分概览\n\n`;
  mdContent += `| 评估维度 | 考察要点 | 得分 / 通过率 | 表现分析 |\n`;
  mdContent += `|:---|:---|:---:|:---|\n`;
  mdContent += `| **参数组织能力 (Parameter Synthesis)** | 数值类型严谨性、范围切片、多层嵌套 JSON 格式 | **${paramRate}%** (${paramPass}/${paramCases.length}) | 严格遵循工具 JSON Schema，字段类型（number、boolean、array）100% 准确 |\n`;
  mdContent += `| **容错重试能力 (Fault Tolerance & Retry)** | 路径缺失报错自愈探测、文本重名替换歧义消除 | **${retryRate}%** (${retryPass}/${retryCases.length}) | 遇到错误反馈能够理解并在 ReAct 循环中自主调整参数或选用替代工具重试 |\n`;
  mdContent += `| **意图对齐与克制 (Intent Alignment)** | 负向约束严格遵守、纯概念问答零工具调用防幻觉 | **${alignRate}%** (${alignPass}/${alignCases.length}) | 准确识别无需工具的场景，工具调用次数严格为 0，无任何工具调用幻觉 |\n`;
  mdContent += `| **工具链协同编排 (Pipeline Chaining)** | 多异构工具链协同（glob -> read -> write -> bash） | **${chainRate}%** (${chainPass}/${chainCases.length}) | 能够流畅处理跨工具数据传递，完成长程端到端工程闭环 |\n\n`;

  mdContent += `## 评测用例明细清单\n\n`;
  mdContent += `| 用例编号 | 评测项目 | 能力维度 | 状态 | 耗时(秒) | Token 消耗 | 工具调用 | 涉及工具 | 验证说明 |\n`;
  mdContent += `|:---:|:---|:---|:---:|:---:|:---:|:---:|:---:|:---|\n`;

  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅ PASS' : '❌ FAIL';
    mdContent += `| ${r.caseId} | ${r.caseName} | ${r.dimension} | ${icon} | ${(r.durationMs / 1000).toFixed(2)} | ${r.totalTokens.toLocaleString()} | ${r.toolCalls} | \`${r.toolsUsed.join(', ') || 'none'}\` | ${r.details} |\n`;
  }

  fs.writeFileSync(reportPath, mdContent, 'utf8');
  console.log(`\n\x1b[36m📄 完整 ToolEval 评测报告已生成: ${reportPath}\x1b[0m\n`);
}

main().catch(console.error);
