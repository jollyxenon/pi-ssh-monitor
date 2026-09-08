## 背景

pi-ssh-target 的终态只来自两个来源：远程 Watcher 的 `finish`/`interrupt` 协议事件，以及本地 SSH 子进程退出时合成的 `close`。`ServerAlive` 保活让 SSH 客户端在通道无响应约 90 秒后退出，从而覆盖了"TCP 半开、服务端失联"的场景。

但事故中出现了第三种失败模式：既有通道完全健康（保活被应答、远程 Watcher 每 5 秒写状态文件），而新 SSH 连接被服务端立即关闭（集群登录节点限流/网关抖动）。此时本地 ssh 永不退出，插件没有任何信号，watch 永久停留在 `started`。用户视角就是"服务器无法联通，但 watcher 没有显示中断"。

## 方案

在 SshWatchManager 中为每个活跃 watch 增加独立的可达性探测循环：

- ready 之后调度首轮探测；间隔 `probe_interval_seconds`（默认 60，`0` 关闭）。
- 每次探测 spawn 一条新的 `ssh` 子进程：argv 为 `[...ssh_args, "-o", "ConnectTimeout=8", "--", host, "exit 0"]`，stdin/stdout 忽略、stderr 管道捕获尾部 2000 字节。密码认证复用 `createAskpassScript()`，脚本在探测结束时立即删除。
- 探测退出码 0 视为成功并重置失败计数；非 0、spawn 失败或 30 秒超时视为失败。连续 `PROBE_FAILURE_THRESHOLD`（2）次失败后，以 error_code `host_unreachable` 合成 `interrupt`，走与远程 `interrupt` 相同的 `finishOnce` 路径（持久化 + steer + 关闭主 SSH 子进程）。
- 探测定时器与在途探测子进程由 `stopProbes()` 统一清理，挂在 `failStartup`、主进程 `close`、`finishOnce`、`cancel`、`closeAll` 上，保证任何终态/取消后不再探测、不泄漏进程。
- 用户可在 `ssh_args` 提供自己的 `ConnectTimeout`（位于默认值之前，OpenSSH 第一个 `-o` 生效）。

## 取舍

- **额外连接开销**：每个活跃 watch 约每分钟一条新 SSH 连接，可能加重服务端限流。默认开启以满足"服务器无法联通必须通报"的需求，同时提供 `probe_interval_seconds=0` 关闭；连续失败阈值 2 避免单次抖动误报。
- **探测与保活重叠**：半开场景下保活约 90 秒触发 `close`，探测约 120 秒触发 `interrupt`；先到者生效，两者不会重复通报（`finishOnce` 保证单终态）。
- **状态语义**：探测失败说明"主机无法建立新 SSH 会话"，不一定是任务进程树异常；因此使用 `interrupt` + 专用提示词（检查网络与主机状态），并在元数据中保留 error_code。
