# Spec Delta

## REMOVED Requirements

### Requirement: 主动监控流程保持首选
**Reason**: 该 requirement 的作用是约束审计与主动监控的优先级；审计删除后不再存在需要协调的第二种监控来源。
**Migration**: 无需迁移。Agent 继续在同一 Agent run 内主动调用 `pi_ssh_watch`，这仍是唯一的 Watcher 建立方式。

### Requirement: agent_settled 后完全异步审计
**Reason**: 审计功能整体删除，不再有 `agent_settled` 后台任务、快照或队列需要生命周期管理。
**Migration**: 无需迁移。`agent_settled` 不再触发任何扩展行为。

### Requirement: 后台审计不得污染正式上下文
**Reason**: 审计功能整体删除，不再写入审计 custom entry，也不再由审计触发补建。
**Migration**: 无需迁移。已有的审计 custom entry 保留在历史 session 中但不再被读取。

### Requirement: 支持可选判断方法
**Reason**: `prefilter_then_llm` 与 `direct_llm` 都只是控制 Judge LLM 的调用时机，审计删除后失去意义。
**Migration**: 无需迁移。配置项 `judgmentMethod` 不再被读取。

### Requirement: 支持可选提交内容
**Reason**: `full_context`、`current_exchange`、`ssh_tool_calls` 只定义提交给 Judge 的对话范围，审计删除后失去意义。
**Migration**: 无需迁移。配置项 `submission` 不再被读取。

### Requirement: 支持 Pi Agent 与独立 Judge 配置
**Reason**: `pi_agent` 与 `independent` 只定义 Judge 模型来源，审计删除后不再有模型调用。
**Migration**: 无需迁移。配置项 `model` 不再被读取。

### Requirement: 完整上下文支持可选缓存
**Reason**: 缓存选项只影响 Judge 请求的 prompt cache retention，审计删除后不再有该请求。
**Migration**: 无需迁移。配置项 `cacheEnabled` 不再被读取。

### Requirement: 使用安全的结构化 Judge 输出
**Reason**: 结构化决策与不可信数据标记只服务于 Judge 输出解析，审计删除后不再存在该输出。
**Migration**: 无需迁移。

### Requirement: 自动补建前必须确定性校验
**Reason**: 确定性校验是自动补建 Watcher 的前置条件，而自动补建随审计一并删除。
**Migration**: 需要监控的远程任务改由 Agent 主动调用 `pi_ssh_watch` 建立；该工具自身的参数校验保持不变。

### Requirement: 每个 session 串行执行后台审计
**Reason**: 串行队列与去重只服务于后台 Judge，审计删除后不再存在后台任务。
**Migration**: 无需迁移。

### Requirement: 提供明确默认配置
**Reason**: 默认配置描述的是审计默认值组合，审计删除后配置文件本身不再被读取。
**Migration**: 无需迁移。`~/.pi/agent/pi-ssh-monitor.json` 可以删除，存在也不会被读取。
