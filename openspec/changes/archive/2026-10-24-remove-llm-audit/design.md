# Design

## Context

审计功能集中在两处：

- `src/audit.ts`：审计证据提取、快照构建、Judge 调用、结构化输出解析与确定性校验。
- `src/audit-config.ts`：读取并校验 `~/.pi/agent/pi-ssh-monitor.json` 的 `audit` 段。

`src/index.ts` 通过三个 hook 把它们接到 Pi 生命周期上：

- `agent_start`：重置本轮证据、候选与覆盖缓冲区。
- `tool_result`：从工具结果提取审计证据，并记录成功 `pi_ssh_watch` 覆盖。
- `agent_settled`：构建快照、入队、串行调用 Judge、校验决策、补建 Watcher、写审计 custom entry。

`pi_ssh_list` 额外输出 `audits` 摘要，`WatchLifecycleRecord` / `WatchState` / `WatchSummary` 带有 `origin: "audit"` 字段。审计还借用了 `auditGeneration` / `auditDisposed` 两个变量来守卫「session 被替换后丢弃过期异步结果」，这一守卫在 `restoreStarted()` 中保护 Watcher 恢复失败的 close 合成，不是审计专有逻辑。

详见 `proposal.md` 的动机。

## Goals / Non-Goals

**Goals:**

- 扩展内不再有任何模型调用，也不再读取审计配置。
- Watcher 只能由 Agent 主动调用 `pi_ssh_watch` 建立。
- 删除后 `pi_ssh_watch` / `pi_ssh_cancel` / `pi_ssh_list` 与远程 Watcher 行为完全不变。
- 保留 `restoreStarted()` 中「过期 session 的恢复失败不得合成 close」这一正确性守卫。

**Non-Goals:**

- 不引入替代的本地自动补建逻辑。
- 不清理历史 session 中已经写入的审计 custom entry。
- 不改动远程 `watcher.py` 协议、SSH 保活或主机可达性探测。

## Decisions

### 1. 整体删除，而不是保留本地补建

候选方案是保留本地正则初筛，命中且 host/PID/ssh_args 能被工具证据精确验证时直接用本地规则补建 Watcher。否决原因：

- 初筛规则（`hasLaunchEvidence`、`extractSshTarget`）本就是为「减少 LLM 调用」而设计的保守启发式，单独用来决定是否启动 SSH 连接风险更高：`extractPid` 对输出里任何 `pid=` 都接受，缺少模型判断后误判面变大。
- 保留它意味着继续维护证据提取、快照、去重与校验这一整套代码，收益只有「Agent 忘记调用工具时兜底」，而用户已明确接受失去这个兜底。

结论：删除 `src/audit.ts`、`src/audit-config.ts` 及所有调用点。

### 2. 把审计代际守卫改名为 session 运行时守卫

`auditGeneration` / `auditDisposed` 当前同时承担两件事：丢弃过期审计快照，以及丢弃过期 `restoreStarted()` 失败回调。删除审计后后者仍然需要。做法：

- 用单个 `runtimeGeneration` 计数器替代 `auditGeneration`，`session_start`、`session_tree`、`session_shutdown` 各自自增一次。
- 删除 `auditDisposed`（其语义已被「代际不匹配」覆盖）。
- `restoreStarted()` 的失败回调守卫改为 `runtimeGeneration !== restoreGeneration`。

不新增任何配置或抽象，只是把已有变量的职责收窄到 Watcher 恢复。

### 3. 删除 `origin: "audit"` 字段

`origin` 的唯一取值是 `"audit"`，删除审计后该字段恒为 `undefined`。按「不保留向后兼容」，从 `WatchLifecycleRecord`、`WatchState`、`WatchSummary` 中删除该字段，并同步 `persist()`、`reconstructWatchStates()`、`summarize()` 中的展开逻辑。旧 session 中带 `origin` 的 lifecycle entry 仍能通过 `isLifecycleRecord` 的 shape 检查（多余字段被忽略），只是不再被读取。

### 4. 删除依赖注入参数

`PiSshMonitorDependencies` 只暴露 `judge` 与 `auditConfig`，仅用于测试注入 Judge。审计删除后该参数没有存在价值，一并删除，`piSshMonitor` 只接收 `pi`。

### 5. 配置文件不读取、不报错

`loadPiSshMonitorConfig()` 及其严格校验（未知字段、无效组合会阻止扩展加载）随 `audit-config.ts` 删除。已存在的 `~/.pi/agent/pi-ssh-monitor.json` 被忽略，不产生警告、不尝试迁移，符合「不保留向后兼容」。

### 6. 删除三个纯审计 hook

`agent_start`、`agent_settled`、`tool_result` 三个 handler 全部只服务审计，整体删除。`session_start`、`session_tree`、`session_shutdown` 保留，只保留 `manager.closeAll()` 与 `restoreStarted()`。

## Risks / Trade-offs

- **失去自动兜底**：Agent 若忘记调用 `pi_ssh_watch`，不再有后台补救。缓解方式是保留并强化工具 description 与 promptGuidelines 中「必须在同一 run 内登记」的措辞。
- **历史审计记录不可见**：`pi_ssh_list` 不再显示 `audits`。旧 session 的审计 custom entry 仍留在 JSONL 中，仅不再被读取。
- **删除面较大**：`index.ts` 有约 120 处审计引用，测试中有大量审计用例。通过先删模块、再删 hook、最后删类型的分步顺序，并在每步后运行 `npm run typecheck` 控制风险。

## Migration Plan

无数据迁移。用户可自行删除 `~/.pi/agent/pi-ssh-monitor.json`，但保留也不会生效。

## Open Questions

（无）
