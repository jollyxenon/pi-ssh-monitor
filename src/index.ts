import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_ACTIVE_LIMIT,
  DEFAULT_TERMINAL_LIMIT,
  isTerminalStatus,
  LIFECYCLE_ENTRY_TYPE,
  MAX_LIST_LIMIT,
  MAX_PASSWORD_LENGTH,
  MESSAGE_TYPE,
  normalizeWatchConfig,
  validateWatchInput,
} from "./constants.js";
import { buildTerminalPrompt } from "./prompts.js";
import { reconstructWatchStates } from "./session-state.js";
import { SshWatchManager, type TerminalEvent } from "./ssh-watch-manager.js";
import type {
  CancelInput,
  ListInput,
  ToolDetails,
  WatchCloseEvent,
  WatchConfig,
  WatchInput,
  WatchLifecycleRecord,
  WatchState,
  WatchSummary,
} from "./types.js";

const WatchParameters = Type.Object({
  host: Type.String({
    description:
      'SSH destination, e.g. "user@example.com" or "example.com" (default user)',
  }),
  pid: Type.Integer({
    minimum: 1,
    description:
      "Remote root PID of the task to monitor; capture it when launching the task, e.g. ssh host 'nohup cmd > /tmp/out.log 2>&1 & echo $!'",
  }),
  description: Type.Optional(
    Type.String({
      description: "Short human-readable label for the task, shown in list output",
    }),
  ),
  ssh_args: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Extra SSH client connection options, e.g. ["-p", "2222"] for a non-default port or ["-i", "/path/to/key"] for a key; keepalive options are appended automatically',
    }),
  ),
  password: Type.Optional(
    Type.String({
      maxLength: MAX_PASSWORD_LENGTH,
      description: "SSH password for password-only servers",
    }),
  ),
  interval_seconds: Type.Optional(
    Type.Number({
      exclusiveMinimum: 0,
      description: "Watcher poll interval in seconds (default 5)",
    }),
  ),
  startup_timeout_seconds: Type.Optional(
    Type.Number({
      exclusiveMinimum: 0,
      description: "Seconds to wait for the watcher to become ready (default 10)",
    }),
  ),
  probe_interval_seconds: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "Seconds between fresh-SSH reachability probes while watching (default 60, 0 disables). Two consecutive probe failures synthesize an interrupt with error_code host_unreachable",
    }),
  ),
  result_paths: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Remote file paths the task is expected to produce; checked after the task finishes",
    }),
  ),
  log_paths: Type.Optional(
    Type.Array(Type.String(), {
      description: "Remote log file paths to monitor while the task is running",
    }),
  ),
  note: Type.Optional(
    Type.String({
      description: "Free-form note for future sessions that resume this watch",
    }),
  ),
});

const CancelParameters = Type.Object({
  watch_id: Type.String({
    description: "Watch ID returned by pi_ssh_watch or pi_ssh_list",
  }),
});

// 本工具没有必填参数，TypeBox 会省略 required 字段；部分 OpenAI 兼容服务（DeepSeek 等）
// 会把缺失的 required 当成 null 并拒绝整个工具 schema，因此显式补上空数组。
const ListParameters = {
  ...Type.Object({
    active_limit: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: MAX_LIST_LIMIT,
        description: "Max active watches to show in list (default 3)",
      }),
    ),
    terminal_limit: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: MAX_LIST_LIMIT,
        description: "Max finished watches to show in list (default 0)",
      }),
    ),
  }),
  required: [] as string[],
};

type PiToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: ToolDetails;
};

/** Registers the pi_ssh_watch / pi_ssh_cancel / pi_ssh_list tools and session lifecycle hooks. */
export default function piSshMonitor(pi: ExtensionAPI): void {
  let states = new Map<string, WatchState>();
  let sessionContext: ExtensionContext | undefined;
  let runtimeGeneration = 0;
  const manager = new SshWatchManager(handleTerminal);

  /** Appends one branch-aware lifecycle entry and updates memory. */
  function persist(record: WatchLifecycleRecord): void {
    pi.appendEntry(LIFECYCLE_ENTRY_TYPE, record);
    states.set(record.watch_id, {
      config: record.config,
      status: record.kind,
      updated_at: record.at,
      ...(record.event === undefined ? {} : { event: record.event }),
      ...(record.error === undefined ? {} : { error: record.error }),
    });
  }

  /** Persists and independently steers every accepted terminal event. */
  function handleTerminal(config: WatchConfig, event: TerminalEvent): void {
    const current = states.get(config.watch_id);
    if (!current || isTerminalStatus(current.status)) return;
    const record: WatchLifecycleRecord = {
      version: 1,
      kind: event.event,
      watch_id: config.watch_id,
      at: event.observed_at,
      config,
      event,
    };
    persist(record);
    pi.sendMessage(
      {
        customType: MESSAGE_TYPE,
        content: buildTerminalPrompt(config, event),
        display: true,
        details: { watch_id: config.watch_id, event: event.event },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }

  /** Synthesizes close when a restored SSH process cannot start. */
  function handleRestoreFailure(config: WatchConfig, error: unknown): void {
    const current = states.get(config.watch_id);
    if (!current || isTerminalStatus(current.status)) return;
    const event: WatchCloseEvent = {
      event: "close",
      watch_id: config.watch_id,
      host: config.host,
      root_pid: config.pid,
      process_count: 0,
      observed_at: new Date().toISOString(),
      state_file: null,
      exit_code: null,
      signal: null,
      stderr_tail:
        error instanceof Error
          ? error.message.slice(-2000)
          : String(error).slice(-2000),
    };
    handleTerminal(config, event);
  }

  /** Restarts branch watches that were still active when the session was saved. */
  async function restoreStarted(ctx: ExtensionContext): Promise<void> {
    states = reconstructWatchStates(ctx.sessionManager.getBranch());
    const restoreGeneration = runtimeGeneration;
    const restoreSessionId = ctx.sessionManager.getSessionId();
    const pending = [...states.values()].filter(
      (state) => state.status === "started",
    );
    for (const state of pending) {
      const config = { ...state.config, resume: true };
      void manager.start(config).catch((error: unknown) => {
        if (
          runtimeGeneration !== restoreGeneration ||
          sessionContext?.sessionManager.getSessionId() !== restoreSessionId
        )
          return;
        handleRestoreFailure(config, error);
      });
    }
  }

  /** Invalidates stale asynchronous work after the session runtime is replaced. */
  function invalidateRuntime(): void {
    runtimeGeneration += 1;
  }

  pi.on("session_start", async (_event, ctx) => {
    invalidateRuntime();
    sessionContext = ctx;
    manager.closeAll();
    await restoreStarted(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    invalidateRuntime();
    sessionContext = ctx;
    manager.closeAll();
    await restoreStarted(ctx);
  });

  pi.on("session_shutdown", async () => {
    invalidateRuntime();
    manager.closeAll();
  });

  pi.registerTool({
    name: "pi_ssh_watch",
    label: "Pi SSH Watch",
    description:
      "Monitor a remote Linux process tree over SSH and notify the local Pi Agent when the task finishes.\n\nRequired: host (SSH destination, e.g. \"user@example.com\") and pid (remote root PID — capture it when launching the task, e.g. ssh host 'nohup cmd > /tmp/out.log 2>&1 & echo $!').\n\nOptional: ssh_args (SSH client options, e.g. [\"-p\", \"2222\"]; keepalive appended automatically), password (for password-only servers), result_paths (files the task should produce, checked after finish), log_paths (log files to watch while running), description, note, interval_seconds (poll interval, default 5), startup_timeout_seconds (watcher startup timeout, default 10), probe_interval_seconds (fresh-SSH reachability probe interval, default 60, 0 disables; two consecutive failures synthesize an interrupt with error_code host_unreachable).",
    promptSnippet:
      "Use when a time-consuming task is running on a remote Linux server and you want to be notified when it ends. Monitors the task process tree via SSH and reports back to Pi Agent.",
    promptGuidelines: [
      "pi_ssh_watch is a tool that can monitor the running status of remote tasks and report real-time to local Pi Agent. It detects whether the remote task has finished running by remotely mounting a \"watcher\" to monitor the status of the task process tree, and notifies the local after the task is completed.",
      "pi_ssh_watch has three return states: if it is \"finish\", the process tree of the task ends completely; If it is \"interrupt\", the monitoring script on the server will have an error; If it is \"close\", the local to remote SSH channel will be disconnected.",
      "pi_ssh_watch will send a message to local Pi Agent to continue the task after it is completed, so Pi Agent does not need to keep watching it and can work on other tasks in the meantime.",
      "pi_ssh_watch requires host and pid: launch the remote task yourself with ssh (e.g. ssh host 'nohup python3 train.py > /tmp/out.log 2>&1 & echo $!'), capture the printed PID, then call pi_ssh_watch with that pid.",
    ],
    parameters: WatchParameters,

    async execute(_toolCallId, rawParams, signal) {
      return executeWatch(rawParams as WatchInput, signal);
    },
  });

  pi.registerTool({
    name: "pi_ssh_cancel",
    label: "Pi SSH Cancel",
    description:
      "Stop watching a remote task. Pass the watch_id returned by pi_ssh_watch or pi_ssh_list.",
    promptSnippet:
      "Use to stop monitoring a remote Linux task whose watch_id is no longer needed.",
    promptGuidelines: [
      "Use pi_ssh_cancel with the watch_id from a prior pi_ssh_watch or pi_ssh_list call to stop monitoring a task.",
    ],
    parameters: CancelParameters,

    async execute(_toolCallId, rawParams) {
      return executeCancel(rawParams as CancelInput);
    },
  });

  pi.registerTool({
    name: "pi_ssh_list",
    label: "Pi SSH List",
    description:
      "List current remote task watches (active, and optionally finished) without connecting to remote hosts.",
    promptSnippet:
      "Use to inspect current remote task watches; optionally pass active_limit (default 3) and terminal_limit (default 0).",
    promptGuidelines: [
      "Use pi_ssh_list to inspect session-persisted watches without connecting to remote hosts.",
    ],
    parameters: ListParameters,

    async execute(_toolCallId, rawParams) {
      return executeList(rawParams as ListInput);
    },
  });

  /** Validates and starts one independent watch, persisting only after ready. */
  async function executeWatch(
    input: WatchInput,
    signal?: AbortSignal,
  ): Promise<PiToolResult> {
    const missing = requireWatchFields(input);
    const error = missing ?? validateWatchInput(input);
    if (error) return errorResult(error);
    const config = normalizeWatchConfig(
      input,
      randomUUID(),
      currentSessionId(),
    );
    try {
      const ready = await manager.start(config, signal);
      const record: WatchLifecycleRecord = {
        version: 1,
        kind: "started",
        watch_id: config.watch_id,
        at: ready.observed_at,
        config,
      };
      persist(record);
      return {
        content: [
          {
            type: "text",
            text: `watch started: ${config.watch_id} (${config.host} PID ${config.pid})`,
          },
        ],
        details: {
          watch: summarize(requiredState(states, config.watch_id)),
        },
      };
    } catch (startError) {
      return errorResult(
        startError instanceof Error ? startError.message : String(startError),
      );
    }
  }

  /** Cancels only a currently active non-terminal watch. */
  function executeCancel(input: CancelInput): PiToolResult {
    if (!input.watch_id) return errorResult("watch_id 不能为空");
    const state = states.get(input.watch_id);
    if (state?.status !== "started" || !manager.cancel(input.watch_id)) {
      return errorResult(
        `watch 不存在、已终止或当前不可取消: ${input.watch_id}`,
      );
    }
    const record: WatchLifecycleRecord = {
      version: 1,
      kind: "cancelled",
      watch_id: input.watch_id,
      at: new Date().toISOString(),
      config: state.config,
    };
    persist(record);
    return {
      content: [{ type: "text", text: `watch cancelled: ${input.watch_id}` }],
      details: {
        watch: summarize(requiredState(states, input.watch_id)),
      },
    };
  }

  /** Lists bounded branch-local summaries without remote I/O. */
  function executeList(input: ListInput): PiToolResult {
    const activeLimit = input.active_limit ?? DEFAULT_ACTIVE_LIMIT;
    const terminalLimit = input.terminal_limit ?? DEFAULT_TERMINAL_LIMIT;
    if (!validListLimit(activeLimit) || !validListLimit(terminalLimit)) {
      return errorResult(`list 数量必须是 0-${MAX_LIST_LIMIT} 的整数`);
    }
    const ordered = [...states.values()].sort((left, right) =>
      right.updated_at.localeCompare(left.updated_at),
    );
    const active = ordered
      .filter((state) => state.status === "started")
      .slice(0, activeLimit)
      .map(summarize);
    const terminal = ordered
      .filter((state) => isTerminalStatus(state.status))
      .slice(0, terminalLimit)
      .map(summarize);
    const lines = [
      `active: ${active.length}`,
      ...active.map(
        (state) =>
          `- ${state.watch_id} ${state.status} ${state.host} PID ${state.pid}${state.description ? ` ${state.description}` : ""}`,
      ),
      `terminal: ${terminal.length}`,
      ...terminal.map(
        (state) =>
          `- ${state.watch_id} ${state.status} ${state.host} PID ${state.pid}${state.description ? ` ${state.description}` : ""}`,
      ),
    ];
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { active, terminal },
    };
  }

  /** Returns current durable session id and rejects ephemeral sessions. */
  function currentSessionId(): string {
    return sessionContext?.sessionManager.getSessionId() ?? "";
  }

  /** Checks action-specific required fields omitted by the broad union schema. */
  function requireWatchFields(input: WatchInput): string | undefined {
    if (typeof input.host !== "string") return "watch 需要 host";
    if (typeof input.pid !== "number") return "watch 需要 pid";
    if (!sessionContext) return "Pi session 尚未初始化";
    return undefined;
  }
}

/** Creates a compact non-throwing tool parameter/startup error result. */
function errorResult(error: string): PiToolResult {
  return {
    content: [{ type: "text", text: `error: ${error}` }],
    details: { error },
  };
}

/** Converts full persisted state into bounded list output. */
function summarize(state: WatchState): WatchSummary {
  return {
    watch_id: state.config.watch_id,
    status: state.status,
    host: state.config.host,
    pid: state.config.pid,
    ...(state.config.description === undefined
      ? {}
      : { description: state.config.description }),
    updated_at: state.updated_at,
    ...(state.event === undefined
      ? {}
      : {
          process_count: state.event.process_count,
          state_file: state.event.state_file,
        }),
    ...(state.error === undefined ? {} : { error: state.error }),
  };
}

/** Returns a persisted state or fails loudly on an internal invariant violation. */
function requiredState(
  states: Map<string, WatchState>,
  watchId: string,
): WatchState {
  const state = states.get(watchId);
  if (!state) throw new Error(`watch 状态未持久化: ${watchId}`);
  return state;
}

/** Validates bounded list override counts. */
function validListLimit(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_LIST_LIMIT;
}
