# Proposal

## Why

远程 Watcher 目前只把「`/proc/<pid>` 条目消失」或「`start_ticks` 变化」当作进程结束，明确不因状态为 `Z`/`X` 提前结束。在共享集群上，父进程不回收子进程时，僵尸进程的 `/proc/<pid>` 条目会长期存在（实测 datatechCPU 上 PID 3487563 已僵尸 3 小时以上），watch 因此永远不产生 `finish`。

2026-10-22 的 `QAOA_Parameter_Generator` 会话里，两个经 codemode 正确 `await` 启动的 watch 都因此漏报：`cc128a2e`（图网络记忆）与 `8ec3428e`（余弦衰减）。Agent 只能手动轮询才发现任务早已完成，随后 `pi_ssh_cancel`；而被取消的远程 Watcher 因为只写 `ready`/`finish`，感知不到本地通道已断，继续每 5 秒扫描，变成占用共享服务器的孤儿进程。

## Changes

- 远程 Watcher 在 PID 不存在、`start_ticks` 变化、或进程状态为 `Z`（僵尸）/`X`（已死亡）时把进程标记为结束。
- 首次登记时根 PID 已是 `Z`/`X` 直接产生 `finish`，与根 PID 不存在时一致。
- 新发现的子进程若已是 `Z`/`X` 直接记为已结束，不参与后续扫描。
- Watcher 每轮扫描前写入一条不匹配协议前缀的心跳并刷新 stdout；SSH 通道关闭导致写入失败（`BrokenPipeError`）时自行退出，消除 cancel、reload、shutdown 和意外断线后的孤儿扫描进程。
- 同步更新 `README.md` 与 `tests/python/test_watcher.py`。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

`remote-process-monitoring`：`Strict disappearance semantics` 被 `Process end detection` 取代（结束判定纳入 `Z`/`X`）；`Initial missing PID behavior` 扩展到根 PID 已僵尸/死亡；新增 `Remote watcher shutdown on channel loss`；`Dynamic process tree discovery` 的结束条件措辞同步为「所有已发现进程都已结束」。

## Impact

- 代码：`src/watcher.py`（结束判定、心跳退出）、`tests/python/test_watcher.py`（Python 单测）、`README.md`（行为说明）。
- 行为：根进程变僵尸后 watch 在一个 `interval_seconds` 内 `finish`；cancel/reload/shutdown/断线后远程 Watcher 在一个 `interval_seconds` 内退出。
- 已知边界：根进程是短命 wrapper、真正任务是被重新托管的子进程时，若子进程在根变僵尸前尚未被发现，可能提前 `finish`。这是原「严格等 PID 消失」想避免的情况；但僵尸的子进程已被重新托管，继续等 PID 消失同样发现不了，且 `finish` 仍要求所有已发现进程都已结束。
