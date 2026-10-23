# Tasks

## 1. 僵尸/死亡状态结束判定

- [x] 1.1 在 `src/watcher.py` 增加 `ENDED_STATES = {"Z", "X"}`，并在 `initialize()`、`scan()` 存活检查和 BFS 发现子进程三处把 `Z`/`X` 记为已结束；验证：`python3 -B -m unittest discover -s tests/python` 中 `test_zombie_root_finishes_at_initialize`、`test_zombie_and_dead_states_end_during_scan`、`test_zombie_descendant_ends_without_keeping_tree_alive` 通过
- [x] 1.2 对 datatechCPU 上真实僵尸 PID 3487563 运行新 watcher，验证 `ready` + `finish` 立即输出；用真实状态文件走 `resume` 路径，验证加载 17 个进程后立即 `finish`

## 2. 通道关闭后远端自行退出

- [x] 2.1 在 `src/watcher.py` 增加 `_heartbeat()`（写空行并 flush，捕获 `OSError`/`ValueError`），并在 `run()` 每轮扫描前检查；验证：`test_closed_channel_ends_watcher_after_ready` 通过
- [x] 2.2 在 datatechCPU 真机验证：起 watcher 后 kill 本地 ssh，远端状态文件的 `last_scanned_at` 不再更新，远端 `python3 -` 退出

## 3. 文档与回归

- [x] 3.1 更新 `README.md`：结束判定改为包含 `Z`/`X`，补充「取消/reload/shutdown 后远端 Watcher 自行退出」说明，并保留短命 wrapper 边界
- [x] 3.2 运行 `npm test`（11 个 Python + 57 个 vitest）、`npm run typecheck`、`npm run build`，全部通过

## Workflow follow-up

- 归档前确认主规格 `openspec/specs/remote-process-monitoring/spec.md` 已由本 delta 同步，且无残留 `Strict disappearance semantics`。
- 归档本 change。
