## 1. 参数与默认值
- [x] 1.1 `src/constants.ts` 新增 `DEFAULT_PROBE_INTERVAL_SECONDS=60`、`PROBE_CONNECT_TIMEOUT_SECONDS=8`、`PROBE_TIMEOUT_SECONDS=30`、`PROBE_FAILURE_THRESHOLD=2`
- [x] 1.2 `WatchMetadataInput`/`WatchConfig` 增加 `probe_interval_seconds`，`normalizeWatchConfig` 应用默认值，`validateMetadata` 拒绝负数（0 允许并关闭探测）
- [x] 1.3 `pi_ssh_watch` TypeBox schema 与工具描述增加 `probe_interval_seconds`（minimum 0）

## 2. 探测循环
- [x] 2.1 `ActiveWatch` 增加 `stateFile`、`probeTimer`、`probeChild`、`probeFailures` 字段
- [x] 2.2 ready 后 `scheduleProbe`；`runProbe` spawn `ssh [...ssh_args, -o ConnectTimeout=8, --, host, "exit 0"]`，密码走 askpass，stderr 尾部限 2000 字节，30 秒整体超时
- [x] 2.3 成功退出码 0 重置计数；失败/超时/spawn 错误计数，达到阈值 2 时 `finishOnce` 合成 error_code `host_unreachable` 的 `interrupt`
- [x] 2.4 `stopProbes` 清理定时器与在途探测，接入 `failStartup`、主进程 close、`finishOnce`、`cancel`、`closeAll`

## 3. 提示词与文档
- [x] 3.1 `buildTerminalPrompt` 为 `host_unreachable` 使用"远程主机 SSH 无法连通"提示词
- [x] 3.2 README：参数表、保活段落后的探测说明、`interrupt` 小节与限制小节
- [x] 3.3 `openspec/specs/remote-process-monitoring/spec.md`：Watch input contract 与新增 `Host reachability probes` requirement

## 4. 测试
- [x] 4.1 `tests/unit/ssh-watch-manager.test.ts` 新增 5 个探测单测（禁用、成功重置、连续失败中断、取消清理、密码 askpass）
- [x] 4.2 `tests/unit/contracts.test.ts` 增加默认值与负数校验断言
- [x] 4.3 集成测试 fixture 显式 `probe_interval_seconds: 0`，避免真实计时器影响
- [x] 4.4 `npm run typecheck`、`npm test` 全绿；真实 sshd 冒烟验证（杀 listener 模拟"新连接被拒、旧通道存活"，4 秒内收到 `host_unreachable` interrupt）
