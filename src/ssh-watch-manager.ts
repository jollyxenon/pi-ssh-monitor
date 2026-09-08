import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_PREFIX, STDERR_TAIL_BYTES, DEFAULT_SSH_KEEPALIVE_ARGS, DEFAULT_PROBE_INTERVAL_SECONDS, PROBE_CONNECT_TIMEOUT_SECONDS, PROBE_TIMEOUT_SECONDS, PROBE_FAILURE_THRESHOLD } from "./constants.js";
import { consumeLines, parseProtocolLine } from "./protocol.js";
import type {
  ActiveWatch,
  WatchCloseEvent,
  WatchConfig,
  WatcherFinishEvent,
  WatcherInterruptEvent,
  WatcherProtocolEvent,
  WatcherReadyEvent,
} from "./types.js";

export type TerminalEvent = WatcherFinishEvent | WatcherInterruptEvent | WatchCloseEvent;
export type SpawnFunction = typeof spawn;

/** Owns one independent SSH child process per active watch. */
export class SshWatchManager {
  private readonly active = new Map<string, ActiveWatch>();
  private readonly ownership = new Map<string, ActiveWatch>();
  private readonly watcherSource: string;

  public constructor(
    private readonly onTerminal: (config: WatchConfig, event: TerminalEvent) => void,
    private readonly spawnProcess: SpawnFunction = spawn,
    watcherSource?: string,
  ) {
    this.watcherSource = watcherSource ?? readFileSync(fileURLToPath(new URL("./watcher.py", import.meta.url)), "utf8");
  }

  /** Starts SSH for an existing PID and resolves after ready. */
  public start(config: WatchConfig, signal?: AbortSignal): Promise<WatcherReadyEvent> {
    return this.startInternal(config, signal);
  }

  /** Runs the SSH protocol and resolves after the remote watcher is ready. */
  private startInternal(
    config: WatchConfig,
    signal?: AbortSignal,
  ): Promise<WatcherReadyEvent> {
    if (signal?.aborted) return Promise.reject(new Error("watch 启动已取消"));
    if (this.active.has(config.watch_id)) throw new Error(`watch 已在运行: ${config.watch_id}`);
    // 默认 keepalive 放在用户 ssh_args 之后：OpenSSH 对重复 -o 选项第一个生效，
    // 因此用户提供的同名选项（在前）生效，未提供时默认值生效。
    const args = [...config.ssh_args, ...DEFAULT_SSH_KEEPALIVE_ARGS, "--", config.host, "python3", "-"];
    // 密码认证：askpass 脚本只读环境变量，脚本本身不含密码明文。
    const askpassPath = config.password === undefined ? undefined : createAskpassScript();
    const env =
      askpassPath === undefined
        ? undefined
        : {
            ...process.env,
            SSH_ASKPASS: askpassPath,
            SSH_ASKPASS_REQUIRE: "force",
            SSH_TARGET_PASSWORD: config.password,
          };
    const child = this.spawnProcess("ssh", args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(env === undefined ? {} : { env }),
    }) as ChildProcessWithoutNullStreams;
    const active: ActiveWatch = {
      config,
      child,
      stderrTail: Buffer.alloc(0),
      ready: false,
      terminalHandled: false,
      intentionalClose: false,
      stateFile: null,
      probeTimer: undefined,
      probeChild: undefined,
      probeFailures: 0,
    };
    this.active.set(config.watch_id, active);
    this.ownership.set(config.watch_id, active);

    return new Promise<WatcherReadyEvent>((resolve, reject) => {
      let stdoutRest = "";
      let settled = false;
      let readyEvent: WatcherReadyEvent | undefined;

      /** Rejects startup and closes only the local SSH child. */
      const failStartup = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        active.intentionalClose = true;
        this.stopProbes(active);
        child.kill();
        this.deleteIfCurrent(active);
        this.releaseOwnership(active);
        reject(error);
      };

      const timeout = setTimeout(() => {
        const tail = active.stderrTail.toString("utf8").trim();
        failStartup(new Error(`SSH Watcher 启动超时（${config.startup_timeout_seconds} 秒）${tail ? `: ${tail}` : ""}`));
      }, config.startup_timeout_seconds * 1000);

      child.stderr.on("data", (chunk: Buffer) => {
        active.stderrTail = Buffer.concat([active.stderrTail, chunk]).subarray(-STDERR_TAIL_BYTES);
      });

      child.stdout.on("data", (chunk: Buffer) => {
        const consumed = consumeLines(stdoutRest, chunk);
        stdoutRest = consumed.rest;
        for (const line of consumed.lines) {
          if (!line.startsWith(PROTOCOL_PREFIX)) continue;
          let event: WatcherProtocolEvent | undefined;
          try {
            event = parseProtocolLine(line);
          } catch (error) {
            const parsedError = error instanceof Error ? error : new Error(String(error));
            if (!active.ready) failStartup(parsedError);
            else {
              this.finishOnce(active, {
                event: "interrupt",
                watch_id: config.watch_id,
                host: config.host,
                root_pid: config.pid,
                process_count: 0,
                observed_at: new Date().toISOString(),
                state_file: readyEvent?.state_file ?? null,
                error_code: "protocol_error",
                error: parsedError.message,
              });
            }
            continue;
          }
          if (!event || event.watch_id !== config.watch_id) continue;
          if (event.event === "ready") {
            if (active.ready) continue;
            active.ready = true;
            active.stateFile = event.state_file;
            readyEvent = event;
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              resolve(event);
              this.scheduleProbe(active);
            }
            continue;
          }
          if (!active.ready && !config.resume) {
            const message = event.event === "interrupt" ? event.error : event.event;
            failStartup(new Error(`远程 Watcher 启动失败: ${message}`));
            continue;
          }
          this.finishOnce(active, event);
        }
      });

      child.on("error", (error) => {
        // spawn 失败不会触发 close，这里兜底清理 askpass 脚本。
        if (askpassPath !== undefined) rmSync(askpassPath, { force: true });
        if (!active.ready) failStartup(error);
      });

      child.on("close", (code, closeSignal) => {
        if (askpassPath !== undefined) rmSync(askpassPath, { force: true });
        clearTimeout(timeout);
        this.deleteIfCurrent(active);
        this.stopProbes(active);
        if (!settled && !active.ready) {
          const error = new Error(this.startupExitMessage(code, closeSignal, active.stderrTail));
          settled = true;
          this.releaseOwnership(active);
          reject(error);
          return;
        }
        if (active.intentionalClose || active.terminalHandled || !active.ready) return;
        this.finishOnce(active, {
          event: "close",
          watch_id: config.watch_id,
          host: config.host,
          root_pid: config.pid,
          process_count: 0,
          observed_at: new Date().toISOString(),
          state_file: readyEvent?.state_file ?? null,
          exit_code: code,
          signal: closeSignal,
          stderr_tail: active.stderrTail.toString("utf8"),
        });
      });

      if (signal) {
        signal.addEventListener("abort", () => failStartup(new Error("watch 启动已取消")), { once: true });
      }

      const remoteConfig = {
        watch_id: config.watch_id,
        session_id: config.session_id,
        host: config.host,
        root_pid: config.pid,
        interval_seconds: config.interval_seconds,
        resume: config.resume,
      };
      const serialized = JSON.stringify(JSON.stringify(remoteConfig));
      child.stdin.end(`import json\nWATCHER_CONFIG = json.loads(${serialized})\n${this.watcherSource}`);
    });
  }

  /** Intentionally closes one active SSH child without creating close terminal state. */
  public cancel(watchId: string): boolean {
    const active = this.active.get(watchId);
    if (!active) return false;
    active.intentionalClose = true;
    this.stopProbes(active);
    active.child.kill();
    this.active.delete(watchId);
    this.releaseOwnership(active);
    return true;
  }

  /** Intentionally closes every session-scoped child during reload or shutdown. */
  public closeAll(): void {
    for (const active of this.active.values()) {
      active.intentionalClose = true;
      this.stopProbes(active);
      active.child.kill();
      this.releaseOwnership(active);
    }
    this.active.clear();
    this.ownership.clear();
  }

  /** Returns whether the current extension instance owns a live child. */
  public has(watchId: string): boolean {
    return this.active.has(watchId);
  }

  /** Removes a watch only if this callback still owns the active map entry. */
  private deleteIfCurrent(active: ActiveWatch): void {
    if (this.active.get(active.config.watch_id) === active)
      this.active.delete(active.config.watch_id);
  }

  /** Releases callback ownership only when this lifecycle still owns the watch ID. */
  private releaseOwnership(active: ActiveWatch): void {
    if (this.ownership.get(active.config.watch_id) === active)
      this.ownership.delete(active.config.watch_id);
  }

  /** Delivers exactly one terminal event, then ensures the SSH child is cleaned up. */
  private finishOnce(active: ActiveWatch, event: TerminalEvent): void {
    if (active.terminalHandled || active.intentionalClose) return;
    active.terminalHandled = true;
    this.stopProbes(active);
    this.deleteIfCurrent(active);
    setImmediate(() => {
      if (this.ownership.get(active.config.watch_id) !== active) return;
      this.ownership.delete(active.config.watch_id);
      this.onTerminal(active.config, event);
    });
    active.child.kill();
  }

  /** Schedules the next reachability probe, or does nothing when probes are disabled. */
  private scheduleProbe(active: ActiveWatch): void {
    if (active.terminalHandled || active.intentionalClose) return;
    const intervalSeconds =
      active.config.probe_interval_seconds ?? DEFAULT_PROBE_INTERVAL_SECONDS;
    if (intervalSeconds <= 0) return;
    active.probeTimer = setTimeout(() => this.runProbe(active), intervalSeconds * 1000);
  }

  /** Runs one reachability probe: a fresh SSH session must exit 0 before the host counts as reachable. */
  private runProbe(active: ActiveWatch): void {
    active.probeTimer = undefined;
    if (
      this.active.get(active.config.watch_id) !== active ||
      active.terminalHandled ||
      active.intentionalClose
    )
      return;
    const askpassPath =
      active.config.password === undefined ? undefined : createAskpassScript();
    const env =
      askpassPath === undefined
        ? undefined
        : {
            ...process.env,
            SSH_ASKPASS: askpassPath,
            SSH_ASKPASS_REQUIRE: "force",
            SSH_TARGET_PASSWORD: active.config.password,
          };
    // ConnectTimeout 放在用户 ssh_args 之后：OpenSSH 对重复 -o 选项第一个生效，
    // 因此用户提供的 ConnectTimeout（在前）生效，未提供时使用探测默认值。
    const args = [
      ...active.config.ssh_args,
      "-o",
      `ConnectTimeout=${PROBE_CONNECT_TIMEOUT_SECONDS}`,
      "--",
      active.config.host,
      "exit 0",
    ];
    let probe: ChildProcessWithoutNullStreams;
    try {
      probe = this.spawnProcess("ssh", args, {
        stdio: ["ignore", "ignore", "pipe"],
        ...(env === undefined ? {} : { env }),
      }) as unknown as ChildProcessWithoutNullStreams;
    } catch (error) {
      if (askpassPath !== undefined) rmSync(askpassPath, { force: true });
      this.recordProbeFailure(
        active,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    active.probeChild = probe;
    let stderrTail = Buffer.alloc(0);
    let killedByTimeout = false;
    const probeTimeout = setTimeout(() => {
      killedByTimeout = true;
      if (active.probeChild === probe) active.probeChild = undefined;
      probe.kill();
    }, PROBE_TIMEOUT_SECONDS * 1000);
    probe.stderr.on("data", (chunk: Buffer) => {
      stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-STDERR_TAIL_BYTES);
    });
    probe.on("error", (error) => {
      clearTimeout(probeTimeout);
      if (askpassPath !== undefined) rmSync(askpassPath, { force: true });
      if (active.probeChild === probe) active.probeChild = undefined;
      this.recordProbeFailure(active, error.message);
    });
    probe.on("close", (code) => {
      clearTimeout(probeTimeout);
      if (askpassPath !== undefined) rmSync(askpassPath, { force: true });
      if (active.probeChild === probe) active.probeChild = undefined;
      if (
        this.active.get(active.config.watch_id) !== active ||
        active.terminalHandled ||
        active.intentionalClose
      )
        return;
      if (code === 0) {
        active.probeFailures = 0;
        this.scheduleProbe(active);
        return;
      }
      const tail = stderrTail.toString("utf8").trim();
      this.recordProbeFailure(
        active,
        killedByTimeout
          ? `超时（${PROBE_TIMEOUT_SECONDS} 秒）`
          : `code=${String(code)}${tail ? `: ${tail}` : ""}`,
      );
    });
  }

  /** Counts a failed probe and interrupts the watch when failures persist. */
  private recordProbeFailure(active: ActiveWatch, detail: string): void {
    if (
      this.active.get(active.config.watch_id) !== active ||
      active.terminalHandled ||
      active.intentionalClose
    )
      return;
    active.probeFailures += 1;
    if (active.probeFailures < PROBE_FAILURE_THRESHOLD) {
      this.scheduleProbe(active);
      return;
    }
    this.finishOnce(active, {
      event: "interrupt",
      watch_id: active.config.watch_id,
      host: active.config.host,
      root_pid: active.config.pid,
      process_count: 0,
      observed_at: new Date().toISOString(),
      state_file: active.stateFile,
      error_code: "host_unreachable",
      error: `连续 ${PROBE_FAILURE_THRESHOLD} 次 SSH 可达性探测失败${detail ? `: ${detail}` : ""}`,
    });
  }

  /** Cancels pending probes and any in-flight probe child for one watch. */
  private stopProbes(active: ActiveWatch): void {
    if (active.probeTimer !== undefined) {
      clearTimeout(active.probeTimer);
      active.probeTimer = undefined;
    }
    const probe = active.probeChild;
    if (probe !== undefined) {
      active.probeChild = undefined;
      probe.kill();
    }
  }

  /** Formats bounded startup diagnostics from an early SSH exit. */
  private startupExitMessage(code: number | null, signal: NodeJS.Signals | null, stderr: Buffer): string {
    const diagnostic = stderr.toString("utf8").trim();
    return `SSH Watcher 启动前退出（code=${String(code)}, signal=${String(signal)}）${diagnostic ? `: ${diagnostic}` : ""}`;
  }
}

/** 创建一次性 askpass 脚本：只输出环境变量中的密码，脚本本身不含明文。 */
function createAskpassScript(): string {
  const scriptPath = join(tmpdir(), `pi-ssh-target-askpass-${randomUUID()}`);
  writeFileSync(
    scriptPath,
    "#!/bin/sh\nprintf '%s\\n' \"$SSH_TARGET_PASSWORD\"\n",
    { mode: 0o700 },
  );
  return scriptPath;
}
