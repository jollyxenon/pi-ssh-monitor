## Why

实测事故（watch `e8a2c2b4-2fab-43b6-a7e6-249dfde32471`）：集群登录节点限流/网关抖动时，新 SSH 连接被立即关闭（`Connection closed by 10.15.171.204 port 30190`），但 watch 自己的既有 SSH 通道仍然存活——服务端持续应答 `ServerAlive` 保活、远程 Watcher 每 5 秒正常写入状态文件。因此本地 ssh 子进程永不退出，插件收不到 `close`，watch 永远停留在 `started`，即使远程主机已"无法联通"。

现有保活机制只能检测 watch 自己那条已建立通道的死亡，无法检测"新连接无法建立"。需要在既有通道之外周期发起新的 SSH 连接探测，连续失败时把 watch 置为 `interrupt`。

## Changes

- `pi_ssh_watch` 新增可选参数 `probe_interval_seconds`（默认 60，`0` 关闭）。
- watch 进入 ready 后，插件按该间隔用相同的 `ssh_args` 与 `password` 发起一条全新探测连接 `ssh <ssh_args> -o ConnectTimeout=8 -- <host> exit 0`，整体预算 30 秒。
- 探测连续失败 2 次时，以 error_code `host_unreachable` 合成 `interrupt` 终态、关闭 watch 的 SSH 子进程并 steer；单次成功重置失败计数；任何终态后停止探测。
- `buildTerminalPrompt` 为 `host_unreachable` 使用专门的提示词（远程主机 SSH 无法连通）。
- 探测 `ConnectTimeout` 放在用户 `ssh_args` 之后，OpenSSH 对重复 `-o` 选项第一个生效，用户同名选项仍可覆盖。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

`remote-process-monitoring`：`Watch input contract` 新增可选 `probe_interval_seconds` 参数；新增 `Host reachability probes` requirement；`interrupt` 通知类型新增 `host_unreachable` 错误码语义。

## Impact

- `src/ssh-watch-manager.ts`：新增探测调度/执行/失败计数与清理逻辑。
- `src/constants.ts`、`src/types.ts`、`src/index.ts`、`src/prompts.ts`：参数、校验、默认值与提示词。
- `README.md`、`openspec/specs/remote-process-monitoring/spec.md`：文档与规格。
- 测试：`tests/unit/ssh-watch-manager.test.ts` 新增探测单测；`tests/unit/contracts.test.ts` 增加默认值与校验断言。
- 默认开启探测会为每个活跃 watch 增加约每分钟一条新 SSH 连接；不希望占用连接数的场景可设 `probe_interval_seconds=0` 关闭。
