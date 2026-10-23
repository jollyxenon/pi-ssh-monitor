# Proposal

## Why

后台遗漏审计是 pi-ssh-monitor 里唯一的模型调用点。默认配置下，每个符合条件的 `agent_settled` 都可能把当前有效分支的完整对话（`full_context`）提交给所选 provider，代价是：不可预期的 token 消耗、一整套后台复杂度（串行队列、批次去重、快照裁剪、session 生命周期失效处理），以及把工具输出与对话内容发给 provider 的隐私面。它换来的唯一收益是「自动补建 Agent 漏掉的 Watcher」，而这个收益本身还要靠本地确定性校验兜底。用户决定不再承担这份成本，让 Watcher 只由 Agent 主动建立。

## What Changes

- **BREAKING** 删除整个后台遗漏审计能力：Judge 模型调用、审计快照、后台串行队列、审计 custom entry、审计配置文件、`pi_ssh_list` 的 `audits` 输出。
- **BREAKING** 删除审计触发的自动补建 Watcher。Watcher 只能由 Agent 在同一 Agent run 内主动调用 `pi_ssh_watch` 建立。
- **BREAKING** 删除 `~/.pi/agent/pi-ssh-monitor.json` 配置读取；该文件不再被读取，存在也会被忽略。
- 从 `src/index.ts` 移除 `agent_start`、`agent_settled`、`tool_result` 三个纯审计 hook。
- 删除仅服务于审计的类型与常量：`AuditSummary`、`AUDIT_ENTRY_TYPE`、`ToolDetails.audits`，以及 `WatchLifecycleRecord` / `WatchState` / `WatchSummary` 上的 `origin: "audit"` 字段。
- 保留 `pi_ssh_watch` / `pi_ssh_cancel` / `pi_ssh_list`、远程 Watcher 协议、SSH 保活与主机可达性探测的现有行为不变。
- 同步更新 `README.md` 与 openspec 主规格。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `background-watch-audit`：该 capability 的全部 11 条 requirements 都只描述审计行为，随功能一并移除，capability 本身删除。
- `automatic-watch-management`：移除 4 条依赖 Judge LLM 的 requirements（本地初筛、受限且不可信的初筛数据、Judge 判断遗漏、审计防重复），并移除文件顶部说明审计取代关系的「后续变更说明」；保留「强制提示 Agent 登记远程长任务」。

## Impact

- 代码：删除 `src/audit.ts`、`src/audit-config.ts`；修改 `src/index.ts`、`src/types.ts`、`src/constants.ts`、`src/session-state.ts`。
- 测试：删除 `tests/unit/audit-config.test.ts`；从 `tests/unit/contracts.test.ts`、`tests/integration/extension.test.ts` 移除审计相关用例。
- 配置：`~/.pi/agent/pi-ssh-monitor.json` 不再被读取，无需迁移。
- 依赖：`src` 不再直接引用 `@earendil-works/pi-ai`（现有的 `StringEnum` 导入本身就是未使用的死代码）。
- 文档：`README.md` 删除「自动遗漏审计」与「审计配置」两节及相关配置表。
