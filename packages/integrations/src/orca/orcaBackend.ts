import {
  BackendError,
  type BackendInfo,
  type BackendMessage,
  type Disposition,
  type KeyValueStore,
  type MessageKind,
  type PollBatch,
  type PollOptions,
  type SettleResult,
  type StartedWorker,
  type StartWorkerInput,
  type WorkerBackend,
  type WorkerInfo,
  WorkerStartError,
} from "@heartwood/core";
import { z } from "zod";
import { execaRunner, type OrcaRunner } from "./runner.js";

export interface OrcaBackendOptions {
  runner?: OrcaRunner;
  /** Orca binary. Defaults to `orca` (resolves to orca.exe on Windows). */
  bin?: string;
  /**
   * Where the adapter remembers which coordinator terminal belongs to which group, so a restarted
   * daemon can keep mutating its groups. Without one, the mapping lives for this process only.
   */
  identity?: KeyValueStore;
  /** Worktree selector the per-group coordinator terminals are created in. Default `active`. */
  coordinatorWorktree?: string;
  /** Length of one long poll. The process timeout adds a margin on top. */
  pollTimeoutMs?: number;
}

const GROUP_KEY = "group:";
const COORDINATOR_TITLE = "heartwood-coordinator";
/** Orca's orchestration contract; without it the lifecycle semantics below do not hold. */
const REQUIRED_CAPABILITY = "orchestration.contract.v1";

// Orca versions update independently: every schema is loose and every optional field may be absent.
const Envelope = z.looseObject({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.string().optional(), message: z.string().optional() }).optional(),
});

const RunCreated = z.looseObject({ run: z.looseObject({ id: z.string() }) });
const TaskCreated = z.looseObject({ task: z.looseObject({ id: z.string() }) });
const Effect = z.looseObject({
  kind: z.string(),
  role: z.string().optional(),
  id: z.string().optional(),
});
const Started = z.looseObject({
  dispatchId: z.string(),
  taskId: z.string(),
  state: z.string().optional(),
  effects: z.array(Effect).optional(),
});
const StartFailure = z.looseObject({
  failedStage: z.string().optional(),
  residualResources: z.array(z.unknown()).optional(),
});
const WorkerRow = z.looseObject({
  dispatchId: z.string(),
  taskId: z.string().optional(),
  agentTerminalHandle: z.string().nullish(),
  projection: z.looseObject({
    liveness: z.looseObject({ verdict: z.string().optional() }).optional(),
    attention: z
      .looseObject({
        categories: z.array(z.string()).optional(),
        requiresAction: z.boolean().optional(),
      })
      .optional(),
  }),
});
const WorkerList = z.looseObject({
  workers: z.array(WorkerRow),
  page: z
    .looseObject({ hasMore: z.boolean().optional(), nextCursor: z.string().nullish() })
    .optional(),
});
const RawMessage = z.looseObject({
  id: z.string(),
  type: z.string(),
  subject: z.string().nullish(),
  body: z.string().nullish(),
  payload: z.union([z.string(), z.record(z.string(), z.unknown())]).nullish(),
});
const Check = z.looseObject({
  deliveryId: z.string().nullable().optional(),
  messages: z.array(RawMessage).default([]),
  connectionLost: z.boolean().optional(),
});
const Settled = z.looseObject({ state: z.string(), reason: z.string().nullish() });
const ReadResult = z.looseObject({
  cursor: z.string().nullish(),
  text: z.string().optional(),
  terminal: z.looseObject({ tail: z.array(z.string()).optional() }).optional(),
});
const Status = z.looseObject({
  runtime: z
    .looseObject({
      appVersion: z.string().optional(),
      capabilities: z.array(z.string()).optional(),
    })
    .optional(),
});
const TerminalCreated = z.looseObject({ terminal: z.looseObject({ handle: z.string() }) });

const LIVENESS = new Set(["live", "unverifiable", "exited"]);

/** Heartwood message kind -> Orca message type (for the wake list), and back. */
const ORCA_TYPE: Record<MessageKind, string | undefined> = {
  done: "worker_done",
  escalation: "escalation",
  question: "question",
  heartbeat: "heartbeat",
  rejected: undefined,
  other: undefined,
};
const KIND_OF: Record<string, MessageKind> = {
  worker_done: "done",
  escalation: "escalation",
  question: "question",
  heartbeat: "heartbeat",
};

/**
 * Worker backend over the `orca … --json` CLI. Everything Orca-specific lives here: the coordinator
 * identity (Orca requires a sender terminal for mutating commands), Dispatch/Run vocabulary,
 * delivery acks, and lifecycle rejections. Never parses human output; unknown fields are ignored.
 */
export class OrcaBackend implements WorkerBackend {
  readonly name = "orca";
  private readonly run: OrcaRunner;
  private readonly pollTimeoutMs: number;
  private readonly volatile = new Map<string, string>();

  constructor(private readonly opts: OrcaBackendOptions = {}) {
    this.run = opts.runner ?? execaRunner(opts.bin);
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 60_000;
  }

  async open(): Promise<BackendInfo> {
    const s = await this.call(["status"], Status);
    const version = s.runtime?.appVersion;
    const problems: string[] = [];
    if (!s.runtime?.capabilities?.includes(REQUIRED_CAPABILITY))
      problems.push(`Orca does not advertise ${REQUIRED_CAPABILITY}`);
    // Identity is per group and provisioned in createGroup, so there is nothing to set up here.
    return { name: this.name, version, compatible: problems.length === 0, problems };
  }

  /**
   * Orca requires a sender terminal for mutating commands and binds it to one Run. The terminal
   * is an identity token only (verified: it need not be typed into). It is created per group and
   * remembered so a restarted daemon can keep mutating that group.
   */
  private async createTerminal(): Promise<string> {
    const created = await this.call(
      [
        "terminal",
        "create",
        "--worktree",
        this.opts.coordinatorWorktree ?? "active",
        "--title",
        COORDINATOR_TITLE,
      ],
      TerminalCreated,
    );
    return created.terminal.handle;
  }

  private async closeTerminal(handle: string): Promise<void> {
    try {
      await this.call(["terminal", "close", "--terminal", handle], z.looseObject({}));
    } catch {
      // best effort: an already-gone terminal is fine
    }
  }

  private async senderFor(groupRef: string): Promise<string[]> {
    const terminal = this.recall(groupRef);
    if (!terminal)
      throw new BackendError(
        `no coordinator terminal is recorded for ${groupRef}; it was not created by this adapter's identity store`,
        "group_identity_missing",
      );
    return ["--from", terminal];
  }

  private recall(groupRef: string): string | undefined {
    return this.opts.identity?.get(`${GROUP_KEY}${groupRef}`) ?? this.volatile.get(groupRef);
  }

  private remember(groupRef: string, terminal: string): void {
    if (this.opts.identity) this.opts.identity.set(`${GROUP_KEY}${groupRef}`, terminal);
    else this.volatile.set(groupRef, terminal);
  }

  private forget(groupRef: string): void {
    this.opts.identity?.delete(`${GROUP_KEY}${groupRef}`);
    this.volatile.delete(groupRef);
  }

  /** Run a command and return `result`. Throws BackendError on `ok:false` or unparsable output. */
  private async call<T>(
    argv: string[],
    schema: z.ZodType<T>,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const r = await this.run([...argv, "--json"], opts);
    const env = this.envelope(r.stdout, r.exitCode, r.stderr);
    if (!env.ok) throw this.failure(env, r.exitCode);
    const parsed = schema.safeParse(env.result);
    if (!parsed.success)
      throw new BackendError(
        `unexpected result from orca ${argv.slice(0, 2).join(" ")}: ${parsed.error.message}`,
        "bad_shape",
        r.exitCode,
      );
    return parsed.data;
  }

  private envelope(stdout: string, exitCode: number, stderr: string) {
    let json: unknown;
    try {
      json = JSON.parse(stdout);
    } catch {
      throw new BackendError(
        `orca exited ${exitCode} with non-JSON output: ${(stderr || stdout).slice(0, 300)}`,
        "non_json",
        exitCode,
      );
    }
    const env = Envelope.safeParse(json);
    if (!env.success)
      throw new BackendError("orca output is not a result envelope", "bad_envelope", exitCode);
    return env.data;
  }

  private failure(env: z.infer<typeof Envelope>, exitCode: number): BackendError {
    return new BackendError(env.error?.message ?? "orca command failed", env.error?.code, exitCode);
  }

  async createGroup(objective: string) {
    // Orca binds a coordinator terminal to its most recent Run, so every group gets its own terminal.
    const terminal = await this.createTerminal();
    try {
      const r = await this.call(
        ["orchestration", "run-create", "--objective", objective, "--from", terminal],
        RunCreated,
      );
      this.remember(r.run.id, terminal);
      return { groupRef: r.run.id };
    } catch (err) {
      await this.closeTerminal(terminal);
      throw err;
    }
  }

  async closeGroup(groupRef: string): Promise<void> {
    const terminal = this.recall(groupRef);
    if (!terminal) return;
    await this.closeTerminal(terminal);
    this.forget(groupRef);
  }

  async createTask(groupRef: string, t: { spec: string; deps?: string[] }) {
    const argv = [
      "orchestration",
      "task-create",
      "--run",
      groupRef,
      "--spec",
      t.spec,
      ...(await this.senderFor(groupRef)),
    ];
    if (t.deps?.length) argv.push("--deps", JSON.stringify(t.deps));
    const r = await this.call(argv, TaskCreated);
    return { taskRef: r.task.id };
  }

  async startWorker(groupRef: string, w: StartWorkerInput): Promise<StartedWorker> {
    if (!!w.spec === !!w.taskRef)
      throw new BackendError("startWorker needs exactly one of spec or taskRef", "bad_request");
    if (w.effort && !w.model) throw new BackendError("effort requires model", "bad_request");
    const argv = ["orchestration", "worker-start", "--run", groupRef];
    argv.push(...(w.taskRef ? ["--task", w.taskRef] : ["--spec", w.spec as string]));
    argv.push("--worktree", w.placement);
    argv.push(...(w.reuse ? ["--terminal", w.reuse] : ["--agent", w.agent]));
    if (w.model) argv.push("--model", w.model);
    if (w.effort) argv.push("--effort", w.effort);
    if (w.name) argv.push("--name", w.name);
    if (w.environment) argv.push("--on", w.environment);
    argv.push(...(await this.senderFor(groupRef)), "--json");

    const r = await this.run(argv);
    const env = this.envelope(r.stdout, r.exitCode, r.stderr);
    if (!env.ok || r.exitCode !== 0) {
      // Never relaunch blindly: surface Orca's receipt so the caller can follow its recovery path.
      const f = StartFailure.safeParse(env.result ?? {});
      throw new WorkerStartError(
        env.error?.message ?? "worker-start failed",
        env.error?.code,
        r.exitCode,
        f.success ? f.data.failedStage : undefined,
        f.success ? (f.data.residualResources ?? []) : [],
      );
    }
    const s = Started.safeParse(env.result);
    if (!s.success)
      throw new BackendError(
        `unexpected worker-start result: ${s.error.message}`,
        "bad_shape",
        r.exitCode,
      );
    const terminal = s.data.effects?.find((e) => e.kind === "terminal" && e.role === "agent");
    return {
      workerRef: s.data.dispatchId,
      taskRef: s.data.taskId,
      locator: terminal?.id,
      // e.g. "outcome_unknown": the first turn could not be observed. Not a failure.
      state: s.data.state ?? "unknown",
    };
  }

  async listWorkers(groupRef: string): Promise<WorkerInfo[]> {
    const out: WorkerInfo[] = [];
    let cursor: string | undefined;
    do {
      const argv = ["orchestration", "worker-list", "--run", groupRef, "--limit", "100"];
      if (cursor) argv.push("--cursor", cursor);
      const page = await this.call(argv, WorkerList);
      for (const w of page.workers) {
        const verdict = w.projection.liveness?.verdict;
        out.push({
          workerRef: w.dispatchId,
          taskRef: w.taskId,
          // anything we cannot read as a positive verdict is absence, never proof of exit
          liveness:
            verdict && LIVENESS.has(verdict) ? (verdict as WorkerInfo["liveness"]) : "unverifiable",
          locator: w.agentTerminalHandle ?? undefined,
          attention: w.projection.attention
            ? {
                categories: w.projection.attention.categories ?? [],
                requiresAction: w.projection.attention.requiresAction ?? false,
              }
            : undefined,
        });
      }
      cursor = page.page?.hasMore ? (page.page.nextCursor ?? undefined) : undefined;
    } while (cursor);
    return out;
  }

  async readWorker(workerRef: string, cursor?: string) {
    const argv = ["orchestration", "worker-read", "--dispatch", workerRef, "--limit", "50"];
    if (cursor) argv.push("--cursor", cursor);
    const r = await this.call(argv, ReadResult);
    return { text: r.terminal?.tail?.join("\n") ?? r.text ?? "", cursor: r.cursor ?? undefined };
  }

  async settleWorker(workerRef: string, disposition: Disposition): Promise<SettleResult> {
    const verb = disposition === "release" ? "worker-release" : "worker-retain";
    const r = await this.call(["orchestration", verb, "--dispatch", workerRef], Settled);
    if (r.state === "released" || r.state === "already_released") return { state: "released" };
    if (r.state === "release_pending") return { state: "pending" };
    if (r.state === "retained") return { state: "retained", reason: r.reason ?? undefined };
    throw new BackendError(`unexpected ${verb} state: ${r.state}`, "unexpected_state");
  }

  async stopWorker(workerRef: string): Promise<void> {
    await this.call(["orchestration", "worker-stop", "--dispatch", workerRef], z.looseObject({}));
  }

  async abandonWorker(workerRef: string): Promise<void> {
    await this.call(
      ["orchestration", "worker-abandon", "--dispatch", workerRef],
      z.looseObject({}),
    );
  }

  async reply(groupRef: string, messageId: string, text: string): Promise<void> {
    await this.call(
      [
        "orchestration",
        "reply",
        "--id",
        messageId,
        "--body",
        text,
        "--run",
        groupRef,
        ...(await this.senderFor(groupRef)),
      ],
      z.looseObject({}),
    );
  }

  async poll(groupRef: string, o: PollOptions): Promise<PollBatch> {
    const types = o.wake.map((k) => ORCA_TYPE[k]).filter((t): t is string => !!t);
    // A consuming check is attributed to its caller; without --terminal it would use whatever Orca
    // terminal the daemon happens to run in, which may be bound to another Run (consumer_fenced).
    const caller = (await this.senderFor(groupRef))[1];
    const argv = [
      "orchestration",
      "check",
      "--run",
      groupRef,
      "--terminal",
      caller as string,
      "--types",
      types.join(","),
    ];
    if (o.ack) argv.push("--ack", o.ack);
    if (o.wait) argv.push("--wait");
    const ms = o.wait ? this.pollTimeoutMs : 1000;
    argv.push("--timeout-ms", String(ms));
    const r = await this.call(argv, Check, { signal: o.signal, timeoutMs: ms + 20_000 });
    if (r.connectionLost)
      throw new BackendError("orca lost its connection to the runtime", "connection_lost");
    return { token: r.deliveryId ?? null, messages: r.messages.map(toMessage) };
  }
}

const Payload = z.looseObject({
  taskId: z.string().optional(),
  dispatchId: z.string().optional(),
  outcome: z.enum(["succeeded", "failed"]).optional(),
  _orcaLifecycleRejection: z
    .looseObject({ code: z.string().optional(), reason: z.string().optional() })
    .optional(),
});

/** Orca messages carry lifecycle fields as a JSON *string* in `payload`; tolerate an object too. */
function toMessage(m: z.infer<typeof RawMessage>): BackendMessage {
  let raw: unknown = m.payload;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = undefined;
    }
  }
  const p = Payload.safeParse(raw ?? {});
  const payload = p.success ? p.data : {};
  const rej = payload._orcaLifecycleRejection;
  return {
    id: m.id,
    // Orca delivers refused lifecycle messages as ordinary messages; they must never settle anything.
    kind: rej ? "rejected" : (KIND_OF[m.type] ?? "other"),
    rawType: m.type,
    workerRef: payload.dispatchId,
    taskRef: payload.taskId,
    outcome: payload.outcome,
    text: m.body ?? m.subject ?? undefined,
    rejection: rej ? { code: rej.code ?? "rejected", reason: rej.reason } : undefined,
  };
}
