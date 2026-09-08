import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SSH_KEEPALIVE_ARGS, PROTOCOL_PREFIX } from "../../src/constants.js";
import { SshWatchManager, type TerminalEvent } from "../../src/ssh-watch-manager.js";
import type { WatchConfig } from "../../src/types.js";

/** Builds a complete normalized watch config for unit tests. */
function config(overrides: Partial<WatchConfig> = {}): WatchConfig {
  return {
    watch_id: "watch-1",
    session_id: "session-1",
    host: "gpu01",
    pid: 123,
    ssh_args: [],
    interval_seconds: 5,
    startup_timeout_seconds: 10,
    probe_interval_seconds: 0,
    result_paths: [],
    log_paths: [],
    resume: false,
    ...overrides,
  };
}

/** Fake SSH child that emits a ready protocol event as soon as stdin ends. */
function fakeChild(watchId: string, host: string, rootPid: number): ChildProcessWithoutNullStreams {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new EventEmitter() as EventEmitter & { end: (chunk?: string) => void };
  stdin.end = () => {
    const ready = {
      event: "ready",
      watch_id: watchId,
      host,
      root_pid: rootPid,
      process_count: 1,
      observed_at: new Date().toISOString(),
      state_file: null,
    };
    stdout.emit("data", Buffer.from(`${PROTOCOL_PREFIX}${JSON.stringify(ready)}\n`));
  };
  return {
    stdout,
    stderr,
    stdin,
    pid: 4242,
    on: vi.fn(),
    kill: vi.fn(),
  } as unknown as ChildProcessWithoutNullStreams;
}

type SpawnImpl = (
  command: string,
  args: string[],
  options: unknown,
) => ChildProcessWithoutNullStreams;

function managerWith(spawnMock: ReturnType<typeof vi.fn<SpawnImpl>>): SshWatchManager {
  return new SshWatchManager(
    (_config: WatchConfig, _event: TerminalEvent) => {},
    spawnMock as unknown as typeof import("node:child_process").spawn,
    "# fake watcher",
  );
}

describe("SshWatchManager default SSH keepalive args", () => {
  it("injects default keepalive options when user provides none", async () => {
    const spawnMock = vi.fn<SpawnImpl>(() => fakeChild("watch-1", "gpu01", 123));
    const manager = managerWith(spawnMock);
    const ready = await manager.start(config());
    expect(ready.event).toBe("ready");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![1]).toEqual([
      ...DEFAULT_SSH_KEEPALIVE_ARGS,
      "--",
      "gpu01",
      "python3",
      "-",
    ]);
  });

  it("keeps user keepalive options before defaults so they override", async () => {
    const spawnMock = vi.fn<SpawnImpl>(() => fakeChild("watch-1", "gpu01", 123));
    const manager = managerWith(spawnMock);
    await manager.start(
      config({ ssh_args: ["-o", "ServerAliveInterval=60", "-o", "ServerAliveCountMax=5"] }),
    );
    expect(spawnMock.mock.calls[0]![1]).toEqual([
      "-o",
      "ServerAliveInterval=60",
      "-o",
      "ServerAliveCountMax=5",
      ...DEFAULT_SSH_KEEPALIVE_ARGS,
      "--",
      "gpu01",
      "python3",
      "-",
    ]);
  });

  it("keeps custom non-keepalive ssh args before defaults", async () => {
    const spawnMock = vi.fn<SpawnImpl>(() => fakeChild("watch-1", "gpu01", 123));
    const manager = managerWith(spawnMock);
    await manager.start(config({ ssh_args: ["-p", "2222", "-i", "/tmp/key"] }));
    expect(spawnMock.mock.calls[0]![1]).toEqual([
      "-p",
      "2222",
      "-i",
      "/tmp/key",
      ...DEFAULT_SSH_KEEPALIVE_ARGS,
      "--",
      "gpu01",
      "python3",
      "-",
    ]);
  });
});

describe("SshWatchManager host reachability probes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Fake probe child whose close event the test triggers explicitly. */
  function fakeProbeChild(): {
    child: ChildProcessWithoutNullStreams;
    events: EventEmitter;
  } {
    const events = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = {
      stdout,
      stderr,
      stdin: { end: vi.fn() },
      on: events.on.bind(events),
      kill: vi.fn(),
    } as unknown as ChildProcessWithoutNullStreams;
    return { child, events };
  }

  it("does not spawn probes when probe_interval_seconds is 0", async () => {
    const spawnMock = vi.fn<SpawnImpl>(() => fakeChild("watch-1", "gpu01", 123));
    const manager = managerWith(spawnMock);
    await manager.start(config());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("resets failure counting after a successful probe", async () => {
    const terminals: TerminalEvent[] = [];
    const probeEvents: EventEmitter[] = [];
    const spawnMock = vi.fn<SpawnImpl>((_command, args) => {
      if (args.at(-1) === "-") return fakeChild("watch-1", "gpu01", 123);
      const probe = fakeProbeChild();
      probeEvents.push(probe.events);
      return probe.child;
    });
    const manager = new SshWatchManager(
      (_config, event) => terminals.push(event),
      spawnMock as unknown as typeof import("node:child_process").spawn,
      "# fake watcher",
    );
    await manager.start(config({ probe_interval_seconds: 60 }));
    await vi.advanceTimersByTimeAsync(60_000);
    probeEvents[0]!.emit("close", 0);
    await vi.advanceTimersByTimeAsync(60_000);
    probeEvents[1]!.emit("close", 255);
    await vi.advanceTimersByTimeAsync(60_000);
    probeEvents[2]!.emit("close", 0);
    expect(terminals).toEqual([]);
    expect(probeEvents).toHaveLength(3);
  });

  it("synthesizes host_unreachable interrupt after consecutive probe failures", async () => {
    const terminals: TerminalEvent[] = [];
    const probeEvents: EventEmitter[] = [];
    const mainChild = fakeChild("watch-1", "gpu01", 123);
    const spawnMock = vi.fn<SpawnImpl>((_command, args) => {
      if (args.at(-1) === "-") return mainChild;
      const probe = fakeProbeChild();
      probeEvents.push(probe.events);
      return probe.child;
    });
    const manager = new SshWatchManager(
      (_config, event) => terminals.push(event),
      spawnMock as unknown as typeof import("node:child_process").spawn,
      "# fake watcher",
    );
    await manager.start(config({ probe_interval_seconds: 60 }));
    await vi.advanceTimersByTimeAsync(60_000);
    probeEvents[0]!.emit("close", 255);
    await vi.advanceTimersByTimeAsync(60_000);
    probeEvents[1]!.emit("close", 255);
    await new Promise((resolve) => setImmediate(resolve));
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      event: "interrupt",
      error_code: "host_unreachable",
      watch_id: "watch-1",
    });
    expect(mainChild.kill).toHaveBeenCalled();
    expect(manager.has("watch-1")).toBe(false);
    // No further probes after the watch turned terminal.
    const spawnCount = spawnMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(spawnMock.mock.calls.length).toBe(spawnCount);
  });

  it("kills the in-flight probe when the watch is cancelled", async () => {
    const probeEvents: EventEmitter[] = [];
    const probes: ChildProcessWithoutNullStreams[] = [];
    const spawnMock = vi.fn<SpawnImpl>((_command, args) => {
      if (args.at(-1) === "-") return fakeChild("watch-1", "gpu01", 123);
      const probe = fakeProbeChild();
      probeEvents.push(probe.events);
      probes.push(probe.child);
      return probe.child;
    });
    const manager = managerWith(spawnMock);
    await manager.start(config({ probe_interval_seconds: 60 }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probes).toHaveLength(1);
    manager.cancel("watch-1");
    expect(probes[0]!.kill).toHaveBeenCalled();
  });

  it("uses askpass env for password probes and removes the script on close", async () => {
    const probeEvents: EventEmitter[] = [];
    const spawnMock = vi.fn<SpawnImpl>((_command, args) => {
      if (args.at(-1) === "-") return fakeChild("watch-1", "gpu01", 123);
      const probe = fakeProbeChild();
      probeEvents.push(probe.events);
      return probe.child;
    });
    const manager = managerWith(spawnMock);
    await manager.start(
      config({ probe_interval_seconds: 60, password: "s3cret-pass" }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const probeOptions = spawnMock.mock.calls[1]![2] as {
      env?: Record<string, string>;
    };
    expect(probeOptions.env?.SSH_ASKPASS_REQUIRE).toBe("force");
    expect(probeOptions.env?.SSH_TARGET_PASSWORD).toBe("s3cret-pass");
    const askpassPath = probeOptions.env?.SSH_ASKPASS;
    expect(askpassPath).toBeTruthy();
    expect(readFileSync(askpassPath!, "utf8")).toContain("$SSH_TARGET_PASSWORD");
    probeEvents[0]!.emit("close", 0);
    expect(existsSync(askpassPath!)).toBe(false);
  });
});
