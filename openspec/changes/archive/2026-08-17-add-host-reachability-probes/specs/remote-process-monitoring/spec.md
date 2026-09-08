## Purpose

本 delta 为 `remote-process-monitoring` 增加主机可达性探测：watch 的既有 SSH 通道存活但新 SSH 连接无法建立时，插件按周期探测并在连续失败后以 `host_unreachable` 合成 `interrupt` 通报。

## MODIFIED Requirements

### Requirement: Watch input contract

`pi_ssh_watch` 工具 SHALL 要求必填字段 `host` 和 `pid`，不提供 `action` 字段。系统 SHALL 接受可选 `description`、`ssh_args[]`、`password`、`interval_seconds`、`startup_timeout_seconds`、`probe_interval_seconds`、`result_paths`、`log_paths` 和 `note`。默认扫描间隔 SHALL 为 5 秒，默认启动超时 SHALL 为 10 秒，默认可达性探测间隔 SHALL 为 60 秒（`0` 关闭）。

#### Scenario: Register a watch with defaults

- **WHEN** Agent 使用合法的 `host` 和活动 PID 调用 `pi_ssh_watch`
- **THEN** 系统为该调用生成唯一 `watch_id`
- **THEN** 系统使用 5 秒扫描间隔、10 秒启动超时和 60 秒可达性探测间隔
- **THEN** 工具在远程 Watcher ready 后返回，不等待目标进程树结束

## ADDED Requirements

### Requirement: Host reachability probes

活跃 watch SHALL 在既有 SSH 通道之外，按 `probe_interval_seconds`（默认 60，`0` 关闭）周期发起一条新的 SSH 连接探测：使用相同的 `ssh_args` 与 `password`，argv 末尾为 `-o ConnectTimeout=8 -- <host> exit 0`，整体探测预算 30 秒。探测连续失败 2 次时，系统 SHALL 以 error_code `host_unreachable` 合成 `interrupt` 终态、关闭该 watch 的 SSH 子进程并 steer。单次探测成功 SHALL 重置失败计数。watch 进入任何终态后系统 SHALL NOT 继续探测。

#### Scenario: New connections fail while the watch channel stays alive

- **WHEN** watch 的既有 SSH 通道仍存活，但连续 2 次探测未能建立新 SSH 会话
- **THEN** 系统记录 error_code 为 `host_unreachable` 的 `interrupt`
- **THEN** 系统关闭该 watch 的 SSH 子进程并发送 steer
- **THEN** 该 watch 不再保持 `started` 状态

#### Scenario: Probe succeeds

- **WHEN** 探测以退出码 0 结束
- **THEN** 系统重置该 watch 的探测失败计数
- **THEN** 系统不产生终态

#### Scenario: Probes disabled

- **WHEN** `probe_interval_seconds` 为 0
- **THEN** 系统不发起探测
