# Spec Delta

## REMOVED Requirements

### Requirement: Agent run 结束后执行本地初筛
**Reason**: 本地初筛的唯一作用是决定是否调用 Judge LLM；Judge 删除后，收集工具证据与筛选候选不再产生任何行为。
**Migration**: 无需迁移。Agent 仍被要求在结束 run 前主动调用 `pi_ssh_watch`，该提示由保留的 requirement「强制提示 Agent 登记远程长任务」覆盖。

### Requirement: 初筛数据必须受限且视为不可信
**Reason**: 截断与不可信标记只服务于提交给 Judge 的审计材料，审计删除后不再有材料提交。
**Migration**: 无需迁移。

### Requirement: 使用独立 Judge LLM 判断遗漏
**Reason**: 该 requirement 直接描述 Judge LLM 判断，功能整体删除。
**Migration**: 需要监控的远程任务由 Agent 主动调用 `pi_ssh_watch` 建立，不再有模型兜底。

### Requirement: 审计必须防止重复和循环
**Reason**: 批次去重与循环防护只服务于审计唤醒流程，审计删除后不再存在该流程。
**Migration**: 无需迁移。
