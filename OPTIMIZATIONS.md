# MyAgent 优化与修复汇总（OPTIMIZATIONS）

本文记录历轮审查发现并已修复的问题。每一项均满足：`npm run build` 通过、`npm test` 93/93 通过、关键行为有冒烟验证。未动项见文末「有意未动 / 后续」。

---

## 1. 执行正确性（第 1 组）

| # | 问题 | 修复 | 文件 |
|---|------|------|------|
| 1.1 | `CANCELLED` 被 `fail()` 覆盖成 `FAILED`，取消语义丢失 | 新增 `ThreadContext.cancel()`（落盘 CANCELLED + 事件），`task-runner` 取消路径改走它；`runTask` 拆 `runTaskInner` + `endTurnOnce`，异常/取消必收尾 Turn | `src/runtime/thread-context.ts`，`src/runtime/task-runner.ts` |
| 1.2 | DAG 死锁（缺依赖/环，`ready==0 && failed==0`）直接 `break` 按 COMPLETED 结算，假成功 | 改显式 `fail(plan.getBlockingReason())`；plan 创建/加载均 `validate()` | `src/runtime/task-runner.ts`，`src/engine/dag.ts` |
| 1.3 | 外部可直接 `milestone.status = ...` 绕过持久化 | `getMilestone(s)/getReady/Failed` 返回防御拷贝，只能经 `markMilestoneStatus` 修改；新增 `validate()` / `findCycle()` / `getBlockingReason()` | `src/engine/dag.ts` |
| 1.4 | `resume` 只重置单点，下游仍 FAILED 下次再死锁；`resultSummary` 残留 | `resetFailedMilestone(id, {cascade:true})` 递归重置下游 FAILED/BLOCKED + 清 `error/resultSummary`；`BreakpointResumer` 默认 cascade | `src/engine/dag.ts`，`src/runtime/breakpoint-resumer.ts` |
| 1.5 | `VerificationGuard`：命令失败但 summary 含 `PASSED/通过/成功` 即判过，幻觉一句绕过 | 删除字符串后门 + `output` 空安全，命令失败即失败 | `src/engine/verification-guard.ts` |
| 1.6 | `Worker`：`JSON.parse` 失败吞成 `{}` 空参执行；`tool_call_id` 双变量错位；失败工具回填空 output | 解析失败回结构化 tool error 自愈；统一 `toolCallId`；失败消息带 error 文本 | `src/engine/worker.ts` |
| 1.7 | `createTurn` 并发可重 ID；`markMilestoneStatus` 只改内存，崩即丢进度 | turnId 碰撞探查；新增 `persistExecutionPlan()` 静默回写，每次状态变更后调用；`setExecutionPlan` 单次序列化复用 | `src/runtime/thread-context.ts` |

---

## 2. 并发与隔离（第 2 组）

| # | 问题 | 修复 | 文件 |
|---|------|------|------|
| 2.1 | `SubagentManager` 无界 `Promise.all` + 同工作区并行写竞态 + `counter+Date.now()` 碰撞 + BLOCKED 压成 FAILED + 无 abort + 未知 role 默认全量 `developer` | 读类（explore/analyst）≤3 并行、写类串行；`allSettled` 收集不抛弃兄弟；`randomUUID`；透传 abort；BLOCKED 保留（子线程 SUSPENDED + remedy 回传）；未知 role 默认只读 analyst；嵌套深度 >2 限只读 ≤2；任务/步数上限（4000 字符/20 步/batch 4） | `src/runtime/subagent-manager.ts`，`src/tools/subagent-tool.ts` |
| 2.2 | DAG 串行跑 `ready[0]`，独立分支不能并行 | ready 批量并行（`maxParallelMilestones` / `MAX_PARALLEL_MILESTONES`，默认 3），`allSettled` 收集，BLOCKED 优先挂起。附带修 `Number(env) ?? 3` → NaN 致空批量 50 轮空转的真 bug | `src/runtime/task-runner.ts` |
| 2.3 | 同轮多 tool_call 全串行 | 只读（read/glob/grep/todowrite/skill）≤5 并行，写串行；step 预占位保序；后被统一内核取代（见 6.1） | `src/engine/worker.ts` |

---

## 3. 持久化与查询（第 3 组 + 性能组）

| # | 问题 | 修复 | 文件 |
|---|------|------|------|
| 3.1 | 无 `WAL/busy_timeout/foreign_keys`，并发 `SQLITE_BUSY` + FK 级联失效 | 启动 `journal_mode=WAL, busy_timeout=5000, synchronous=NORMAL, foreign_keys=ON` | `src/persistence/db.ts` |
| 3.2 | 索引缺失（`parent_thread_id`、`current_state`、`session_id`、`steps(status)` 等全表扫描） | 补 11 个索引 | `src/persistence/db.ts` |
| 3.3 | `ALTER TABLE` 靠抛错控制流；`task_→session_` 迁移无事务、逐行 prepare、异常 FK 永久 OFF、Dashboard 每次请求重跑 | `user_version` 门控；迁移单事务 + 复用 prepared + finally 恢复 FK（修了第一版 FK 常开致迁移违约束静默失败的回归） | `src/persistence/db.ts` |
| 3.4 | `synthesizeSessionHistory` N+1（每 turn 一次 prepare）；`listAcpSessions` `SELECT *` 拉 MB 级 history + limit 未钳 | steps 单次 `IN` 批量；显式列 + limit 钳 1..200 | `src/persistence/db.ts` |
| 3.5 | `recordTurn/StepStart/End` 多语句非原子（并发计数漂移）；`COUNT(*)` 每 turn 全扫；每步 `SELECT parent` | 事务包裹；`total_turns+1` 原子递增；`parentCache`；`duration MAX(0,·)` | `src/persistence/telemetry-store.ts` |
| 3.6 | `getThreadMetrics` 8 查询（5 次重复子查询 + `OR` 杀索引 + 4 次 COUNT） | 单 CTE + 单次 `GROUP BY step_type,tool_name`，内存派生全部指标；`SELECT *` 改显式列 | `src/persistence/telemetry-store.ts` |
| 3.7 | `appendEvent` 高频 autocommit；`getEventsByThread` 无 LIMIT 全量 OOM | `appendEventsBatch` 单事务批量；`{after,limit}` 分页（上限 5000） | `src/persistence/event-store.ts` |
| 3.8 | 恢复半愈合（无事务）+ 只愈合 RUNNING/PLANNING（SUSPENDED_* 永卡）+ 时钟回拨 | 事务 + 全 5 态覆盖 + `MAX(0,·)` | `src/persistence/recovery.ts` |
| 3.9 | 黑板全量读改写丢计数；artifacts/milestones 无限增长；`getModifiedFiles` 拉 `diff_content` | token 计数内存主 + DB 懒播种；milestone 留 20 / artifact 留 500（内存+DB）；`DISTINCT file_path`；新增 `getFileLedger()` 轻量路径+动作 | `src/context/blackboard.ts` |
| 3.10 | `deleteSession` N×6 往返 + 只删一层子（孙子成孤儿）+ 无事务；`clear` 无事务 + 全量 VACUUM 锁库 | 递归 CTE 全后代 + 单事务批量删；clear 包事务 + `incremental_vacuum` 代全量 VACUUM | `src/dashboard/dashboard-service.ts` |
| 3.11 | `export` N+1 连接 + 双份大字符串驻留 | `streamDatabaseExport` 逐会话流式写（O(1) 内存，`threads` 别名复读）；路由改 chunked 流 + `?limit=`（默认 500）；`exportFullDatabaseJson` 保持形状兼容 | `src/dashboard/dashboard-service.ts`，`src/dashboard/dashboard-router.ts` |
| 3.12 | Dashboard POST body 无上限；HTML 每次同步读盘；`getSessionList` 全量 prompt 建树；`resumeSession` 无超时/互斥 | 1MB bounded body（413）；HTML 内存缓存 + ETag/304；prompt 截 500 + 2000 行上限；resume 互斥锁 + 120s 超时 | 同上 |

---

## 4. 协议与传输（第 3 组）

| # | 问题 | 修复 | 文件 |
|---|------|------|------|
| 4.1 | `onMessage` fire-and-forget（`unhandledRejection`）；`pendingClientRequests` 永不清理 + timer 拖进程；未知响应 id 静默丢；client 可控 id 覆盖在途请求；`err.code \|\|` 误判 | catch 上报；`timer.unref()` + send 异常清理 + `closePendingRequests()`；未知 id 告警；重复在途 id 拒 `INVALID_REQUEST`；`??` + 条件 data | `src/protocol/rpc-dispatcher.ts` |
| 4.2 | stdio buffer 无界 OOM；parse 失败只 log（无 PARSE_ERROR）；`Buffer` chunk 类型错 | 4MB 单行/8MB buffer 上限；best-effort `PARSE_ERROR`（正则 recover id）；chunk 兼容 | `src/protocol/stdio-transport.ts` |
| 4.3 | HTTP body 无上限；复用 id 覆盖他人 pending（响应劫持）；close 对已发送头 `writeHead` 抛错 | 1MB 上限 413；重复 id 400；`headersSent` 守卫 | `src/protocol/http-transport.ts` |
| 4.4 | `dual` 以裸 id 为键，stdio id=1 与 http id=1 互覆盖；未知响应广播泄漏；origins 无 TTL | 复合键 `transportIdx:id`；未知/歧义响应丢弃 + 告警；5min TTL + 1000 条上限；`addTransport` 去重 | `src/protocol/dual-transport.ts` |

---

## 5. 安全（安全组）

| # | 问题 | 修复 | 文件 |
|---|------|------|------|
| 5.1 | `WorkspaceJail` 无 symlink 解析 + `startsWith` 缺分隔符（`/tmp/ws2` 绕 `/tmp/ws`）+ 敏感名单过窄 | realpath（不存在则向上找最近存在祖先）+ 分隔符感知 + root 自身 symlink 回退比对（macOS `/tmp`）；名单补 `*.pem/*.key/.aws/.docker/.npmrc/credentials/secrets/token/.pki` + basename 匹配；不存在路径不误杀（修了 `/tmp` 场景 3 用例回归） | `src/security/workspace-jail.ts` |
| 5.2 | `isReadOnlyCommand` 正则易绕（`2>file`、`$VAR`、`~/`、`sed -i''`、缺解释器全家桶）；`npm view` 联网算只读；大小写 risk 不一致 | `$`背tick`~` 直接非只读；`<>` 全禁；危险表补解释器/包管理器/网络工具（`sed` 全禁）；npm 只读集删 `view/info`；`riskLevel` 大写归一 | `src/security/policy-engine.ts` |
| 5.3 | `alwaysApproved` 按 toolName 永久全局（`bash(ls)` 放行后 `bash(rm -rf /)` 全放）；outcome `includes()` 模糊匹配 | `session:tool:fnv(args)` 作用域 + 1h 过期；精确枚举匹配，未知 outcome 默认拒绝 | `src/security/approval-gate.ts` |
| 5.4 | `authenticated` 从未检查；`authenticate` 空 token 即成功；`mcp/mount` 任意命令 + env 覆盖 `PATH/LD_PRELOAD`；`skills/reload` 任意目录 | `requireAuth` 选项 + `MYAGENT_REQUIRE_AUTH`（默认关，本地 stdio 兼容；开后特权方法 `-32000`）；token ≥8 校验；MCP env 块名单；reload 约束 workspace 内；cwd 归一化（存在性强制因与 `session/list` 过滤键语义冲突而回退，见 5.7） | `src/index.ts` |
| 5.5 | `bash` 用 `sh -c` 不受 cwd 约束 + 全量 env（含 API Key）泄漏 + 只杀 sh 留孙进程 + 无 abort + 10MB 全缓冲 | `spawn` + 白名单 env + `detached` 进程组杀 + `abortSignal` 透传 + 流式 512KB 截断 + command 8K/超时钳 | `src/tools/core-tools.ts` |
| 5.6 | `patch` 根本没应用 diff 就返 success；`question` 假交互；`skillName` 路径穿越；`invoke_subagent` 标 READ_ONLY 可写文件 | 最小 unified-diff applier（hunk 校验，失配/无 hunk/超 256KB 拒绝）；`question` 经 `elicitation/create` 真阻塞（headless 明确 UNANSWERED）；skill 名白名单；subagent 提 HIGH_RISK_EXEC | `src/tools/extended-tools.ts`，`src/tools/subagent-tool.ts`，`src/tools/tool-registry.ts`（路径参数全提取 + `requestElicitation` 通道） |
| 5.7 | `acp-client`：fs 无 handler 直读宿主任意文件；terminal 无 handler 假 `exitCode:0`；elicitation 假 submit；`respond` 可多次调用 | 全部 fail-closed（`-32601`）；respond once-guard + 首 listener 胜出 | `src/client/acp-client.ts` |

---

## 6. 引擎与上下文（本轮）

| # | 问题 | 修复 | 文件 |
|---|------|------|------|
| 6.1 | Worker/DirectLoop 双份 ~250 行 ReAct（流聚合 + 工具执行各写一遍；DirectLoop 还有 silent-`{}`、串行、usage 覆盖三个 bug） | 新 `src/engine/agent-loop-core.ts`：`aggregateStream`（usage 累加、args 256KB 截断、`finishReason` 透传）、`parseToolCalls`（严格错返）、`runToolCalls`（读并行 ≤5/写串行、有序 step、emit、熔断记录、FATAL 分类）、`createElicitationBridge`、`reportParseErrors`、`toolKind`；两端接入，DirectLoop 顺带修掉三个 bug | `src/engine/agent-loop-core.ts`（新），`src/engine/worker.ts`，`src/engine/direct-agent-loop.ts` |
| 6.2 | 每 LLM 迭代重建 L1/L2（4+ DB 读 + 全量 schema），破坏 prefix-cache | L1 提模块常量；`MAX_CONTEXT_CHARACTERS` 构造缓存；黑板 `version` 计数 + L2（目标/总结/技能/ledger/todos/budget）按 `turnId+version+hash+skills` memoize（100 条 FIFO）；ledger 走 `getFileLedger()` 不拉 diff | `src/context/dynamic-context-assembler.ts`，`src/context/blackboard.ts` |
| 6.3 | 并行工具交错 `read-modify-write`，后写覆盖先写 | `src/tools/file-lock.ts`（新）：per-path promise 队列，同文件串行、不同文件并行，用完删键；edit/write/patch 接入 | `src/tools/file-lock.ts`（新），`src/tools/core-tools.ts`，`src/tools/extended-tools.ts` |
| 6.4 | `grep` 同步递归卡事件循环 + ReDoS + 跟随 symlink（循环/逃逸）+ 读 `.git`/二进制 OOM；`glob` 未走 jail + 正则注入 + 无界结果 + `Date.now()` 冒充 mtime + `**/*.txt` 顶层零命中 | 双双异步化：`opendir` + `lstat` 永不跟随链接 + 跳 `.git/node_modules/dist` + 文件/字节/条目上限 + 超时/abort + 二进制启发跳过；grep 并发 8 读、结果排序确定化、pattern 500 限、非法正则友好错；glob 子目录 jail 双重 containment、glob 通配转义后拼接、目录 mtime 实测、`**/` 按 basename 匹配（顺带修了顶层零命中） | `src/tools/core-tools.ts` |
| 6.5 | `read` 无大小上限（2G 日志 OOM） | 5MB 拒 + 行切片指引 | `src/tools/core-tools.ts` |
| 6.6 | 熔断器 `sha256+md5` 每次调用 + 空白/键序可躲 + 成功循环不触发 + 只认 A-B-A | FNV-1a + 参数归一化（排序键/trim）；成功重复阈值；滑动窗口任意环（A-B-C-A 照抓）；原断言文案不变；`resetTurn` 补 `modelIterations` 清零 | `src/engine/loop-detector.ts` |
| 6.7 | 错误分类仅 5 种 FATAL，429/401/overflow 全算 TRANSIENT 空转预算 | `RATE_LIMITED`/`PROVIDER_UNAVAILABLE`/`CONTEXT_OVERFLOW`(`needsCompaction`)/`ABORTED`(`retryable:false`，不破坏取消语义)/`MODEL_NOT_FOUND`；新增可选 `retryable/backoffMs/needsCompaction`，老调用方零改 | `src/engine/error-classifier.ts` |
| 6.8 | Planner `Set` 每调重建 + 同步读 package.json + 贪婪 `\{[\s\S]*\}` + catch 吞 FATAL（401/取消也回退假计划） | 模块常量；异步读；字符串感知平衡括号 `extractJsonObject()`（导出）；abort/401/403/404 重抛 | `src/engine/planner.ts` |
| 6.9 | `temperature`/`maxTokens` 定义了从没用过（硬编码 0.2） | config/env/单次三级透传进请求 body | `src/provider/openai-provider.ts` |
| 6.10 | 流解析丢 `data:{...}` 无空格帧 + `usage` 覆盖 + `finish_reason` 丢弃 + 非流 `message` 不认 + 并行 tool_call 串扰 + 逐行 warn 刷屏 | 已在前轮修空格帧/累加/截断/取消/日志截断；本轮补 `message` 回退 + `finishReason` 捕获透传（`CompletionResult.finishReason` + `StreamDeltaChunk.finishReason`） | `src/provider/stream-parser.ts`，`src/provider/types.ts` |
| 6.11 | compactor 日志无轮转/穿越/碰撞 | 文件名消毒 + 随机后缀 + LRU（100MB/200 文件） | `src/context/memory-compactor.ts` |

---

## 7. 有意未动 / 后续

- **cwd 存在性强制**：试过，不兼容 `session/list` 的 cwd 过滤键语义（测试用 `/workspace/projectA` 等虚拟键）而回退。边界由每线程 jail + `requireAuth` 保证。
- **`getSessionDetail` 的 `subagentSteps` 归属启发式**（`childRows.find` 恒 true 错挂）：本轮未动——改精确匹配需调用链透传 callId，风险大于收益，待协议层加 parent 字段后修。
- **`edit/write` TOCTOU（check-then-act）**：file-lock 已消同进程竞态；跨进程/符号链接调包需 `O_NOFOLLOW` fd 化重写，待单独立项。
- **工具级超时/并发上限**（`tool.execute` 无 `Promise.race`，LLM 并发 N×bash）：待 `p-limit` + 每工具超时。
- **状态机 `COMPLETED→RUNNING` 宽松回迁**：为 retry/resume 预留，动前需先定语义。
- **配置集中化**（`MAX_STEPS` 等散落 `Number(env)`）：`AgentConfig` 单例待立项。
- **`sanitizeMessages` 连续 assistant 乱序**、**`choices[n>1]` 丢弃**：低频边缘，待 Provider 下一轮。
- **HTTP SSE 主动请求广播、`handleDashboardHttpRequest` 鉴权前置、CORS `*`**：需产品决策（鉴权模型），未动。
