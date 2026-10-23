# Tasks

## 1. 删除审计模块与运行时接线

- [x] 1.1 删除 `src/audit.ts` 与 `src/audit-config.ts`；验证：`fd -t f 'audit' src/` 无输出
- [x] 1.2 在 `src/index.ts` 删除审计 import、`PiSshMonitorDependencies`、`QueuedAudit` 类型、`agent_start` / `agent_settled` / `tool_result` 三个 hook，以及 `runAuditQueue`、`appendAudit`、`isAuditSnapshotCurrent`、`hasWatchCoverage`、`auditRecord`、`countDecisions`、`recordCoverage`、`latestAuditSummaries` 与全部审计状态变量；`piSshMonitor` 只接收 `pi` 一个参数；验证：`npm run build` 通过
- [x] 1.3 把 `auditGeneration` / `auditDisposed` 收窄为单个 `runtimeGeneration` 计数器，`session_start`、`session_tree`、`session_shutdown` 各自自增一次，`restoreStarted()` 的失败回调守卫改用该代际；验证：`npm run build` 通过，且 `rg -n "audit" src/` 无匹配
- [x] 1.4 删除 `src/constants.ts` 的 `AUDIT_ENTRY_TYPE`、`src/types.ts` 的 `AuditSummary` 与 `ToolDetails.audits`，以及 `WatchLifecycleRecord` / `WatchState` / `WatchSummary` 的 `origin` 字段；同步删除 `src/session-state.ts` 与 `src/index.ts` 中 `origin` 的读写；验证：`npm run build` 通过
- [x] 1.5 `executeList` 删除 `audits` 行与 `details.audits`，保留 `active` / `terminal`；验证：`npm run build` 通过
- [x] 1.6 删除 `src/index.ts` 中未使用的 `StringEnum` 导入；验证：`rg -n "pi-ai" src/` 无匹配
- [x] 1.7 更新 `README.md`：删除「自动遗漏审计」与「审计配置」两节，更新 `pi_ssh_list` 的输出说明与「限制」章节中的审计条目；验证：`rg -n "审计|Judge|LLM" README.md` 无匹配

## 2. 清理审计测试

- [x] 2.1 删除 `tests/unit/audit-config.test.ts`；验证：`test ! -f tests/unit/audit-config.test.ts`
- [x] 2.2 从 `tests/unit/contracts.test.ts` 删除审计 import 与审计用例（审计默认值、候选提取、Judge 输出解析、三种提交模式、判断方法、缓存与模型选择、API key 覆盖），保留 defaults、metadata、protocol、lifecycle、terminal prompt 用例；验证：`npx vitest run tests/unit/contracts.test.ts` 通过
- [x] 2.3 从 `tests/integration/extension.test.ts` 删除所有 `judge` 注入与审计用例，包括 `origin === "audit"` 与 `details.audits` 断言，保留工具执行与 session 生命周期用例；验证：`npx vitest run tests/integration/extension.test.ts` 通过
- [x] 2.4 全量验证：`npm run typecheck`、`npm test`、`npm run build` 全部通过

## Workflow follow-up

- 归档前运行 `openspec validate remove-llm-audit --strict`，确认 delta 与主规格一致。
- 归档本 change。
