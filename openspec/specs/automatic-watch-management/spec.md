## Purpose

让 Pi Agent 更可靠地为远程 Linux 长任务建立进程树监控，并提供一次调用即可完成任务启动、PID 获取和 Watcher 登记的安全接口。
## Requirements
### Requirement: 强制提示 Agent 登记远程长任务
系统 SHALL 在 `pi_ssh_watch` 激活时明确要求 Agent：启动预计长期运行或脱离当前 SSH 命令的远程 Linux 任务后，必须在同一 Agent run 内调用 `pi_ssh_watch` 登记 Watcher，或明确说明无法登记的原因。系统 SHALL NOT 提供 `start` action 作为登记入口。

#### Scenario: 长任务正常登记
- **WHEN** Agent 通过普通 SSH 启动远程长任务并获得稳定根 PID
- **THEN** 系统提示 Agent 在结束当前 run 前调用 `pi_ssh_watch`

#### Scenario: 无法登记
- **WHEN** Agent 无法获得稳定 PID、任务已结束或用户明确拒绝监控
- **THEN** Agent 可以不创建 Watcher，但必须向用户说明原因
