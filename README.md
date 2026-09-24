# MyAgent — 长任务 Agent 运行时

> 基于 ACP 协议的长周期、多步骤智能体运行时：Thread-Turn-Step 分层执行、Event Sourcing 持久化、Planner-Worker DAG 编排、OpenAI 协议兼容。

`myagent` 是一个用 TypeScript / Node.js 构建的本地优先 Agent Runtime。一次长任务被建模为 `Thread → Turn → Step` 三层结构，全链路记录耗时 / Token / 工具调用，崩溃后可断点续跑，并通过标准 ACP（Agent Client Protocol，JSON-RPC 2.0）对接编辑器、CLI、Web Dashboard。

详细架构规范见 [`design.md`](./design.md)。

---

## 特性一览

| 能力 | 说明 |
| :--- | :--- |
| **ACP 协议兼容** | `initialize` / `session/new` / `session/prompt` / `session/load` / `session/cancel` / `session/request_permission` / `session/update`，支持 stdio / HTTP+SSE / dual 三种传输 |
| **Thread-Turn-Step 分层** | Thread（任务全局）→ Turn（PLANNING / WORKER / APPROVAL / USER_INPUT / SUMMARY）→ Step（MODEL_CALL / TOOL_EXECUTION / APPROVAL_WAIT / CONTEXT_COMPACT / ARTIFACT_INDEXING） |
| **多维 Telemetry** | 每个 Step 精确计时 + Token 聚合，Turn / Thread 逐级汇总，可按阶段、工具、模型下钻分析 |
| **Durable Execution** | `node:sqlite` + Event Sourcing（`threads` / `turns` / `steps` / `task_events` / `blackboard_entries` / `artifacts`），崩溃重启后回放恢复 |
| **Planner-Worker + DAG** | Planner 拆解 Milestone DAG，Worker 按拓扑调度，带双重验收守卫（确定性命令 + 结构化自证） |
| **鲁棒性熔断器** | Transient vs Fatal 错误分类、Fast-Fail 阻断、动作指纹去重、振荡检测、Turn/Thread 硬顶预算 |
| **断点增量恢复** | `session/load` / `task/resume` 只重置失败节点，已 SUCCESS 的 Milestone 与黑板数据保留，零重跑 |
| **Sub-agent 隔离** | `invoke_subagent` 工具孵化 Child Thread（`parent_thread_id`），独立上下文 + 摘要回传，Dashboard 可见协作树 |
| **安全 HITL** | 四级风险（READ_ONLY / WORKSPACE_WRITE / HIGH_RISK_EXEC / NETWORK_OR_CRITICAL）+ Workspace Jail + ACP `session/request_permission` 审批挂起 |
| **工具与技能** | 内置 `bash` / `read` / `write` / `edit` / `grep` / `glob` / `patch` / `todowrite` / `skill` / `question` / `plan`，技能支持 `.agent/skills` 动态加载，MCP Server 可动态 mount |
| **模型适配** | OpenAI Chat Completions 兼容（`fetch` + SSE 流解析 + `tool_calls` 拼接 + 429/5xx 指数退避），DeepSeek / Qwen / Ollama 等中转均可 |
| **TUI + Dashboard** | Ink/React 终端 TUI，多 DB 切换的 Web Dashboard（会话树、Turn/Step 明细、工具耗时排行、Token 汇总、一键 resume/delete/export） |
| **评测体系** | `npm run eval`（5 维能力基准）+ `npm run tooleval`（工具调用专项）+ 20 个 `tests/*.test.ts`，报告落盘 `eval_reports/` |

---

## 架构

```
Client (Zed / VSCode / CLI / Web)
        │  ACP JSON-RPC 2.0 (stdio / SSE)
        ▼
Agent Runtime Core
├── ACP Adapter & Router (session 管理 / 流式推送 / 权限网关)
├── Thread-Turn-Step 执行控制器 (计时 + Token 聚合 + Step 遥测)
├── Planner-Worker DAG 引擎 (规划 / 调度 / 验收 / 熔断 / 断点恢复)
├── Context & Memory (全局 Blackboard / Worker 短期上下文 / 自动压缩截断)
├── Skills & Tools (+ MCP 网关 + invoke_subagent)
├── Security (PolicyEngine + WorkspaceJail + ApprovalGate)
├── Provider (OpenAI 兼容 client + SSE 解析 + 重试)
└── Persistence (node:sqlite + Event Store + Telemetry 查询)
```

---

## 快速开始

### 1. 环境要求

- Node.js `>= 22`（用到 `node:sqlite`、`fetch`、`ReadableStream`、`AbortController` 原生能力）
- npm / pnpm 均可

### 2. 安装与构建

```bash
npm install
npm run build
```

`build` 会执行 `tsc` 并把 `src/dashboard/public` 拷贝到 `dist/dashboard/`。

### 3. 配置模型

任选一种方式（优先级：环境变量 > `.env` > `~/.pi/agent/auth.json`）：

```bash
export OPENAI_API_KEY="sk-..."
export OPENAI_BASE_URL="https://api.deepseek.com/v1"  # OpenAI / DeepSeek / Qwen / Ollama 中转均可
export OPENAI_MODEL="deepseek-chat"
```

或在项目根目录 / `~/.myagent/.env` 放置：

```bash
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_MODEL=deepseek-chat
```

`resolveDefaultProvider()`（`src/index.ts:233`）会自动按上述顺序发现配置。

### 4. 运行

```bash
# 方式 A：ACP stdio 模式（默认，供 Zed / Cursor / VSCode 以子进程接入，stdout 保持纯 JSON-RPC）
npm start
node dist/index.js --mode=stdio

# 方式 B：HTTP + SSE 模式（远程 / Web UI）
node dist/index.js --http --port=3000
# 控制指令 POST /rpc，事件流 GET /events

# 方式 C：双通道
node dist/index.js --dual --port=3000

# 方式 D：单任务控制台（无需编辑器，直接跑一个 prompt，支持 HITL 交互审批）
npm run task -- "分析当前项目目录结构，在 docs/project_overview.md 写模块概览" --auto-approve
npm run task -- --resume=<sessionId> "继续推进"

# 方式 E：终端 TUI（Ink/React）
npm run tui

# 方式 F：Web Dashboard 后端
npm run dashboard
```

持久化默认落盘 `~/.myagent/data.db`（见 `src/config/paths.ts`），任务级产物在 `.agent/tasks/<threadId>/metrics_summary.json`。

---

## ACP 接口速查

### Agent 端（Client → Agent）

| 方法 | 说明 |
| :--- | :--- |
| `initialize` | 握手，协商 `protocolVersion`，返回 agent 支持的 tools/skills |
| `authenticate` / `logout` | 传入 `token`/`apiKey` 动态切换 Provider |
| `session/new` | 建会话（绑定 `cwd`/`roots`，可选 mount `mcpServers`），返回 `sessionId` + modes/config |
| `session/prompt` | 发送需求并启动执行循环；运行中再次调用则作为 steering 排队；结束返回 `stopReason`（`end_turn` / `cancelled` / `requires_action` / `error`）+ metrics |
| `session/load` | 加载历史会话并回放 `history`；带 `targetMilestoneId`/`userHint` 时触发断点续跑 |
| `session/resume` | 恢复会话上下文（cwd / mcpServers 可更新） |
| `session/list` / `session/close` / `session/delete` | 会话列表 / 关闭（abort 执行流）/ 删除 |
| `session/set_mode` | 切换 `code` / `ask` / `architect` |
| `session/set_config_option` | 修改 `mode` / `model` / `auto_approve` 等配置项 |
| `session/cancel` / `$/cancel_request` | 中断在途执行（级联 `AbortController.abort()`） |
| `task/start` / `task/resume` / `task/status` | 非编辑器客户端的任务中心化别名 |
| `mcp/mount` / `mcp/unmount` / `mcp/list` | MCP Server 动态挂载管理 |
| `skills/list` / `skills/reload` | 技能列表 / 热重载 |

### Client 端（Agent → Client）

`session/request_permission`（HITL 审批）、`fs/read_text_file`、`fs/write_text_file`、`terminal/*`、`elicitation/create`，以及 `session/update` 流式通知（`agent_message_chunk` / `tool_call` / `usage_update` / `available_commands_update` / `subagent_started|finished` 等）。

协议类型定义：`src/protocol/types.ts`；分发器：`src/protocol/rpc-dispatcher.ts`；传输层：`src/protocol/stdio-transport.ts`、`http-transport.ts`、`dual-transport.ts`。

---

## 工具与技能

### 内置工具（`src/tools/`）

| 工具 | 风险等级 | 用途 |
| :--- | :--- | :--- |
| `bash` | HIGH_RISK_EXEC | 工作区内执行 shell（`npm test` / `git status`），带超时与输出截断 |
| `edit` | WORKSPACE_WRITE | 精确 `oldStr → newStr` 替换，LLM 改代码主通道 |
| `write` | WORKSPACE_WRITE | 新建 / 全量覆盖文件，自动建父目录 |
| `read` / `grep` / `glob` | READ_ONLY | 文件切片读 / 正则搜 / 模式找文件 |
| `patch` | WORKSPACE_WRITE | 应用 Unified Diff |
| `todowrite` | READ_ONLY | TODO 清单，同步到 Blackboard |
| `skill` | READ_ONLY | 按需加载 `SKILL.md` |
| `question` | READ_ONLY | 向用户提问，挂起为 `SUSPENDED_INPUT` |
| `plan` (`planTaskTool`) | READ_ONLY | 查看 / 更新当前 DAG 计划 |
| `invoke_subagent` | 受 PolicyEngine 管控 | 委派子智能体独立攻坚，只回传摘要 |

`webfetch` / `websearch` 已从默认注册中移除以收紧网络面；MCP 工具由 `McpManager`（`src/mcp/mcp-manager.ts`）动态注入。

### 技能（`src/skills/`）

- `SkillRegistry` 从 `<root>/.agent/skills`、`skills/` 自动扫描并 watch 热加载。
- 内置 `analyst` / `developer` / `qa` 等角色技能，Worker 按 `workerSkill` 装配最小工具子集。

MCP 配置示例（`<root>/.agent/mcp.json`，`autoLoadMcp` 默认加载）：

```json
{
  "servers": [{ "id": "fs", "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }]
}
```

---

## 执行语义（关键行为）

- **规划 → 执行 → 验收**：`PLANNING` Turn 产出 Milestone DAG → 每个可执行 Milestone 一个 `WORKER` Turn → 通过 `VerificationGuard`（`acceptanceCriteria` 命令 `exitCode===0` 优先，否则结构化自证）才标 SUCCESS → 全 SUCCESS 进 `SUMMARY` 产出 Diff + metrics（`src/engine/verification-guard.ts`）。
- **错误分类**：Transient（语法错/单测失败/429/503）允许 Turn 步数预算内自愈重试；Fatal（缺凭证/服务不可达/缺依赖/提示矛盾）立即 Fast-Fail 切 `SUSPENDED_INPUT` 并结构化通知用户（`src/engine/error-classifier.ts`）。
- **防死锁**：`(toolName, params)` 指纹连续失败 2 次熔断；近 6 步 `A→B→A` 振荡检测；单 Turn 默认 ≤10 Step；Thread 级 Token/超时硬顶（`src/engine/loop-detector.ts`）。
- **上下文**：全局 Blackboard（目标/DAG/文件清单）+ Worker 短期上下文 + 工具输出截断（>8000 字符取首尾）+ 70% 水位渐进式压缩（`src/context/`）。
- **取消/转向**：`session/cancel` 中止当前 Turn；`session/prompt` 在 RUNNING 时进入 steering 队列注入下一 Turn。

---

## Telemetry 与 Dashboard

SQLite 表：`threads` / `turns` / `steps` / `task_events` / `blackboard_entries` / `artifacts` / `acp_sessions`，建表见 `src/persistence/db.ts`，查询封装在 `src/persistence/telemetry-store.ts`。

常用分析（完整 SQL 见 `design.md §11`）：Turn 耗时/Token 流水、工具调用频次与失败率、`MODEL_CALL` vs `TOOL_EXECUTION` vs `APPROVAL_WAIT` 耗时占比。

任务结束自动生成：

```json
{
  "threadId": "session_xxx",
  "totalDurationMs": 45820,
  "totalTokens": { "promptTokens": 18450, "completionTokens": 3210, "totalTokens": 21660 },
  "counts": { "turns": 5, "steps": 14, "toolCalls": 8, "modelCalls": 4, "approvals": 1 },
  "timeAllocation": { "modelInferenceMs": 8420, "toolExecutionMs": 28600, "approvalWaitMs": 8500 }
}
```

Web Dashboard（`src/dashboard/` + `scripts/dashboard-server.ts`）提供：多 DB 切换、KPI 汇总、主/子会话树、单会话 Turn→Step 下钻（含 subagent 嵌套步骤）、工具/skill 统计、resume / delete / export JSON。

---

## 开发脚本

| 命令 | 说明 |
| :--- | :--- |
| `npm run build` / `watch` | `tsc` 构建（含 dashboard 静态资源拷贝）/ 监听 |
| `npm start` / `npm run dev` | 运行 `dist/index.js`（ACP stdio） |
| `npm test` | `node --experimental-strip-types --test tests/*.test.ts`（20 套，覆盖 ACP 合规、DAG、熔断、恢复、遥测、MCP、技能、双传输等） |
| `npm run task -- "<prompt>"` | 单任务控制台（含 `--auto-approve` / `--resume=`），实现 `scripts/run-task.ts` |
| `npm run eval` | 5 维基准评测（代码生成 / Bug 修复 / 多文件推理 / 安全越界 / 测试闭环），报告写入 `eval_reports/eval_report_*.md` |
| `npm run tooleval` | 工具调用专项评测，报告写入 `eval_reports/tooleval_report_*.md` |
| `npm run tui` | Ink 终端 UI（`src/tui/`） |
| `npm run dashboard` | Dashboard 后端（`scripts/dashboard-server.ts`） |

---

## 目录结构

```
myagent/
├── design.md                 # 架构设计规范（Thread-Turn-Step / 状态机 / 安全 / 度量）
├── src/
│   ├── index.ts              # CLI 入口 + createAgentRuntime + 全部 ACP 方法注册
│   ├── protocol/             # ACP 类型 / stdio / http(SSE) / dual / rpc-dispatcher
│   ├── runtime/              # thread/turn/step 上下文 / task-runner / 状态机 / 恢复 / subagent
│   ├── engine/               # planner / worker / dag / 验证守卫 / 错误分类 / 熔断 / 压缩
│   ├── persistence/          # node:sqlite 建表 / event-store / telemetry / recovery
│   ├── context/              # blackboard / memory-compactor / dynamic-context-assembler
│   ├── security/             # policy-engine / workspace-jail / approval-gate
│   ├── tools/                # tool-registry / core / extended / plan / subagent-tool
│   ├── skills/               # skill-registry + builtin
│   ├── mcp/                  # mcp-client / mcp-manager
│   ├── provider/             # openai 兼容 client / SSE 解析 / 重试
│   ├── client/               # AcpClient（测试/脚本用）+ memory/http transport
│   ├── config/paths.ts       # ~/.myagent 路径与 DB/skill/env 定位
│   ├── dashboard/            # dashboard-service/router + 前端 public/
│   └── tui/                  # Ink 终端 UI
├── scripts/                  # run-task / run-eval / run-tooleval / dashboard-server
├── tests/                    # 20 套 node:test 用例
└── eval_reports/             # 评测输出报告
```

---

## License

MIT
