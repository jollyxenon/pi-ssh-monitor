# Spec Delta

## REMOVED Requirements

### Requirement: Strict disappearance semantics

**Reason**: 该要求规定 `Z`/`X` 状态不得提前结束进程，导致僵尸进程的 `/proc/<pid>` 条目长期存在时 watch 永不结束。行为被 `Process end detection` 取代。

**Migration**: 使用新的 `Process end detection`：进程状态为 `Z` 或 `X` 时立即记录为已结束。

## MODIFIED Requirements

### Requirement: Initial missing PID behavior

首次创建 watch 时，如果根 PID 已不存在或状态为 `Z`/`X`，Watcher SHALL 立即产生 `finish`，而不是把登记操作作为错误。

#### Scenario: PID ended before registration

- **WHEN** SSH 和远程环境有效，但 `watch` 开始时根 PID 已不存在或已是僵尸/已死亡状态
- **THEN** Watcher 写入终态状态文件
- **THEN** Watcher 输出 `finish`
- **THEN** 插件立即 steer Agent

### Requirement: Dynamic process tree discovery

Watcher SHALL 每轮扫描所有尚未结束的已知进程，并通过 `/proc/<pid>/task/*/children` 递归发现新后代。Watcher SHALL 继续跟踪所有已发现后代，即使根进程已经消失或后代已经被其他父进程接管。

#### Scenario: Child outlives root process

- **WHEN** Watcher 已发现一个子进程，随后根 PID 消失或变为 `Z`/`X`，而子进程仍保持相同身份
- **THEN** Watcher 继续监控该子进程
- **THEN** Watcher 不发送 `finish`，直到所有已发现进程都已结束

#### Scenario: New descendant appears

- **WHEN** 一个尚未结束的已知进程在后续扫描中出现新的 child PID
- **THEN** Watcher 读取该 PID 的身份和启动时间
- **THEN** Watcher 把该进程加入当前 watch 状态

## ADDED Requirements

### Requirement: Process end detection

Watcher SHALL 在 PID 不存在、PID 的启动时间变化、或进程状态为 `Z` 或 `X` 时将原进程标记为结束。僵尸进程（`Z`）已经终止且无法再运行，其 `/proc/<pid>` 条目可能因父进程不回收而长期存在，Watcher SHALL NOT 因此把它视为仍在运行。

#### Scenario: Zombie process remains present

- **WHEN** 已跟踪 PID 的状态为 `Z`，但 PID 和 `start_ticks` 仍匹配
- **THEN** Watcher 把该进程记录为已结束
- **THEN** 当所有已发现进程都已结束时，Watcher 发送 `finish`

#### Scenario: Dead process state

- **WHEN** 已跟踪 PID 的状态为 `X`
- **THEN** Watcher 把该进程记录为已结束

#### Scenario: Proc entry disappears during a scan

- **WHEN** 读取过程中出现 `ENOENT` 或 `ESRCH`
- **THEN** Watcher 把对应进程记录为已结束
- **THEN** 该竞态不产生 `interrupt`

### Requirement: Remote watcher shutdown on channel loss

远程 Watcher SHALL 在每轮扫描前写入一条不匹配协议前缀的心跳并刷新 stdout。当 SSH 通道关闭导致写入失败时，Watcher SHALL 直接退出，SHALL NOT 继续扫描或留下无人接收的孤儿进程。

#### Scenario: Local cancel or reload closes the SSH channel

- **WHEN** 插件取消 watch、关闭全部 watch 或 Pi 退出，从而结束本地 SSH 子进程
- **THEN** 远程 Watcher 在下一次心跳写入失败后退出

#### Scenario: Unexpected SSH drop

- **WHEN** SSH 连接因网络断开而在本地未被及时感知
- **THEN** 远程 Watcher 在下一次心跳写入失败后退出，不长期占用远程资源
