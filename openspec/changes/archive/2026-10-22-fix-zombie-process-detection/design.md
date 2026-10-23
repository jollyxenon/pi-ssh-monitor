# Design

## Context

远程 Watcher 是单文件 `python3 -` 脚本，每轮读取 `/proc/<pid>/stat` 得到 `pid`、`state`、`start_ticks`，用 `boot_id + PID + start_ticks` 校验身份，并把进程状态原子写入 `/tmp/pi-ssh-monitor-<uid>/<session>/<watch>.json`。`ProcStat.state` 早已解析出来，但只用于解析单测，从未参与存活判定；结束条件是「`/proc/<pid>` 不存在」或「`start_ticks` 变化」。

本地侧只有一条 `ssh ... python3 -` 子进程，脚本通过 stdin 一次性传入后 stdin 即关闭，没有控制通道。`pi_ssh_cancel`、`/reload`、shutdown 只 `kill()` 本地 ssh 子进程；SSH 是非交互无 pty 会话，sshd 不会因此给远端发 `SIGHUP`，远端 `python3 -` 会继续运行。

详见 `proposal.md` 的动机与现场证据。

## Goals / Non-Goals

**Goals:**

- 僵尸/已死亡进程不再被当成「仍在运行」，watch 在任务真正结束后一个 `interval_seconds` 内产生 `finish`。
- 取消、reload、shutdown 或意外断线后，远程 Watcher 自行退出，不在共享服务器上长期占用资源。

**Non-Goals:**

- 不改变 `boot_id + PID + start_ticks` 身份模型和状态文件格式。
- 不新增参数、配置项或工具。
- 不保证发现根进程退出前从未被扫描到、且已被重新托管的未知后代。

## Decisions

### 1. 用 `/proc/<pid>/stat` 的状态字符判定僵尸/死亡

Linux 在 `/proc/<pid>/stat` 中把进程状态放在 `)` 之后的第一个字段：`Z` 为僵尸（已终止、等父进程 `wait()` 回收），`X` 为已死亡。`parse_proc_stat` 已把它解析成 `ProcStat.state`。

判定规则：`state in {"Z", "X"}` 即视为结束。理由：

- 僵尸的 PID 与 `start_ticks` 都仍然有效，`/proc/<pid>` 条目不会消失，所以必须显式看 `state`，不能靠条目是否存在。
- 僵尸进程无法被 `kill`，只能由父进程回收；「等父进程回收」在父进程不 `wait()` 时是无界的。

备选：读 `/proc/<pid>/status` 的 `State:` 行或 `/proc/<pid>/cmdline` 为空。前者多一次文件读，后者对内核线程同样为空、区分度差。`/proc/<pid>/stat` 是现有唯一数据源，改动最小。

落地位置：`initialize()`（根已是 `Z`/`X` → 直接 `finish`）、`scan()` 的已知进程存活检查、以及 BFS 发现新子进程时（已是 `Z`/`X` 直接记 `ended_at`，不再入队）。`finished = all(record.ended_at is not None)` 保持不变，因此已发现的活子进程仍会阻止提前 `finish`。

### 2. 用 stdout 心跳让远端在通道关闭后自行退出

每轮扫描前向 stdout 写一个空行并 `flush()`。空行不匹配协议前缀，本地解析器按设计忽略它。Python 默认忽略 `SIGPIPE`，因此管道读端消失时 `write` 抛 `BrokenPipeError`；`_heartbeat()` 捕获 `OSError`/`ValueError` 后返回 `False`，`run()` 静默返回 0。

备选与放弃原因：

- **在 `ready` 事件里上报 watcher PID，取消时另开一条 SSH `kill`**：需要协议字段、`ActiveWatch` 记录、askpass/密码在取消路径复用、PID 复用校验；`closeAll()` 在 Pi 退出阶段还要发起多条 SSH，脆弱且代码量大。
- **`ssh -tt` 申请 pty 让 sshd 在通道关闭时发 `SIGHUP`**：pty 会回显 stdin、并把 `\n` 变成 `\r\n`，干扰一次性传入脚本和协议流。
- **让 watcher 读 stdin 作为控制通道**：`python3 -` 必须读到 EOF 才能编译执行脚本，stdin 无法在脚本运行期间复用。

心跳的额外好处：本地 Pi 崩溃或网络静默断开时，远端同样会在一个 `interval_seconds` 内退出。

### 3. 不提升状态文件版本

`STATE_VERSION` 保持 1，字段不变。resume 时 `initialize()` 只加载状态，随后第一次 `scan()` 用新规则把僵尸记录标为结束；无需迁移。

## Risks / Trade-offs

- **根进程是短命 wrapper、真正任务是被重新托管的子进程** → 若子进程在根变 `Z` 前未被扫描到，可能提前 `finish`。原「严格等 PID 消失」正是为规避此情况，但僵尸的子进程已被重新托管，等 PID 消失同样发现不了它；`finished` 仍要求所有**已发现**进程都已结束。该边界保留在 README 的限制清单中。
- **心跳延迟** → 取消后远端最多再扫描一个 `interval_seconds` 才退出（默认 5 秒，用户可设更大值）。相比长期孤儿进程可接受。
- **升级前已存在的 watch** → 旧远程 Watcher 没有心跳，仍会在根进程消失后退出；僵尸场景需要重新 `pi_ssh_watch`。README 已说明保活只对新建 SSH 子进程生效的同类约束。
- **心跳行** → 每个扫描周期在 SSH 流里增加一个空行，本地解析器忽略，开销可忽略。

## Migration Plan

无数据迁移。新版本加载后，新建 watch 使用新语义；`started` 状态的旧 watch 在 `/reload`/session 恢复时由新代码重新拉起，随即按新规则判定。回滚只需还原代码，状态文件格式兼容。

## Open Questions

无。
