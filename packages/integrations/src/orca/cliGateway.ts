import {
  type CheckOptions,
  type Disposition,
  type MailboxBatch,
  OrcaCliError,
  type OrcaGateway,
  type OrcaMessage,
  OrcaStartError,
  type SettleResult,
  type StartedWorker,
  type StartWorkerInput,
  type WorkerProjection,
} from "@heartwood/core";
import { z } from "zod";
import { execaRunner, type OrcaRunner } from "./runner.js";

export interface OrcaCliOptions {
  runner?: OrcaRunner;
  /** Orca binary. Defaults to `orca` (resolves to orca.exe on Windows). */
  bin?: string;
  /**
   * Terminal handle used as sender (`--from`) for mutating commands when the daemon does not run
   * inside an Orca terminal. Verified: run-create/task-create/worker-start fail with
   * `no_active_sender_terminal` without one; `check`/`worker-*` take only `--run`/`--dispatch`.
   */
  senderTerminal?: string;
  /** Length of one long poll. The process timeout adds a margin on top. */
  pollTimeoutMs?: number;
}

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

const LIVENESS = new Set(["live", "unverifiable", "exited"]);

/** Orca gateway over the `orca … --json` CLI. Never parses human output; unknown fields are ignored. */
export class OrcaCliGateway implements OrcaGateway {
  private readonly run: OrcaRunner;
  private readonly from: string[];
  private readonly pollTimeoutMs: number;

  constructor(opts: OrcaCliOptions = {}) {
    this.run = opts.runner ?? execaRunner(opts.bin);
    this.from = opts.senderTerminal ? ["--from", opts.senderTerminal] : [];
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 60_000;
  }

  /** Run a command and return `result`. Throws OrcaCliError on `ok:false` or unparsable output. */
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
      throw new OrcaCliError(
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
      throw new OrcaCliError(
        `orca exited ${exitCode} with non-JSON output: ${(stderr || stdout).slice(0, 300)}`,
        "non_json",
        exitCode,
      );
    }
    const env = Envelope.safeParse(json);
    if (!env.success)
      throw new OrcaCliError("orca output is not a result envelope", "bad_envelope", exitCode);
    return env.data;
  }

  private failure(env: z.infer<typeof Envelope>, exitCode: number): OrcaCliError {
    return new OrcaCliError(env.error?.message ?? "orca command failed", env.error?.code, exitCode);
  }

  async createRun(objective: string) {
    const r = await this.call(
      ["orchestration", "run-create", "--objective", objective, ...this.from],
      RunCreated,
    );
    return { runId: r.run.id };
  }

  async createTask(runId: string, t: { spec: string; deps?: string[] }) {
    const argv = ["orchestration", "task-create", "--run", runId, "--spec", t.spec, ...this.from];
    if (t.deps?.length) argv.push("--deps", JSON.stringify(t.deps));
    const r = await this.call(argv, TaskCreated);
    return { taskId: r.task.id };
  }

  async startWorker(runId: string, w: StartWorkerInput): Promise<StartedWorker> {
    if (!!w.spec === !!w.taskId)
      throw new OrcaCliError("startWorker needs exactly one of spec or taskId", "bad_request");
    if (w.effort && !w.model) throw new OrcaCliError("effort requires model", "bad_request");
    const argv = ["orchestration", "worker-start", "--run", runId];
    argv.push(...(w.taskId ? ["--task", w.taskId] : ["--spec", w.spec as string]));
    argv.push("--worktree", w.worktree);
    argv.push(...(w.terminal ? ["--terminal", w.terminal] : ["--agent", w.agent]));
    if (w.model) argv.push("--model", w.model);
    if (w.effort) argv.push("--effort", w.effort);
    if (w.name) argv.push("--name", w.name);
    if (w.env) argv.push("--on", w.env);
    argv.push(...this.from, "--json");

    const r = await this.run(argv);
    const env = this.envelope(r.stdout, r.exitCode, r.stderr);
    if (!env.ok || r.exitCode !== 0) {
      // Never relaunch blindly: surface Orca's receipt so the caller can follow its recovery path.
      const f = StartFailure.safeParse(env.result ?? {});
      throw new OrcaStartError(
        env.error?.message ?? "worker-start failed",
        env.error?.code,
        r.exitCode,
        f.success ? f.data.failedStage : undefined,
        f.success ? (f.data.residualResources ?? []) : [],
      );
    }
    const s = Started.safeParse(env.result);
    if (!s.success)
      throw new OrcaCliError(
        `unexpected worker-start result: ${s.error.message}`,
        "bad_shape",
        r.exitCode,
      );
    const terminal = s.data.effects?.find((e) => e.kind === "terminal" && e.role === "agent");
    return {
      dispatchId: s.data.dispatchId,
      taskId: s.data.taskId,
      terminalHandle: terminal?.id,
      // e.g. "outcome_unknown": the first turn could not be observed. Not a failure.
      state: s.data.state ?? "unknown",
    };
  }

  async listWorkers(runId: string): Promise<WorkerProjection[]> {
    const out: WorkerProjection[] = [];
    let cursor: string | undefined;
    do {
      const argv = ["orchestration", "worker-list", "--run", runId, "--limit", "100"];
      if (cursor) argv.push("--cursor", cursor);
      const page = await this.call(argv, WorkerList);
      for (const w of page.workers) {
        const verdict = w.projection.liveness?.verdict;
        out.push({
          dispatchId: w.dispatchId,
          taskId: w.taskId,
          // anything we cannot read as a positive verdict is absence, never proof of exit
          liveness:
            verdict && LIVENESS.has(verdict)
              ? (verdict as WorkerProjection["liveness"])
              : "unverifiable",
          terminalHandle: w.agentTerminalHandle ?? undefined,
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

  async readWorker(dispatchId: string, cursor?: string) {
    const argv = ["orchestration", "worker-read", "--dispatch", dispatchId, "--limit", "50"];
    if (cursor) argv.push("--cursor", cursor);
    const r = await this.call(argv, ReadResult);
    return { text: r.terminal?.tail?.join("\n") ?? r.text ?? "", cursor: r.cursor ?? undefined };
  }

  async settleWorker(dispatchId: string, disposition: Disposition): Promise<SettleResult> {
    const verb = disposition === "release" ? "worker-release" : "worker-retain";
    const r = await this.call(["orchestration", verb, "--dispatch", dispatchId], Settled);
    const state = r.state;
    if (state === "released" || state === "already_released") return { state: "released" };
    if (state === "release_pending") return { state: "pending" };
    if (state === "retained") return { state: "retained", reason: r.reason ?? undefined };
    throw new OrcaCliError(`unexpected ${verb} state: ${state}`, "unexpected_state");
  }

  async stopWorker(dispatchId: string): Promise<void> {
    await this.call(["orchestration", "worker-stop", "--dispatch", dispatchId], z.looseObject({}));
  }

  async abandonWorker(dispatchId: string): Promise<void> {
    await this.call(
      ["orchestration", "worker-abandon", "--dispatch", dispatchId],
      z.looseObject({}),
    );
  }

  async check(runId: string, o: CheckOptions): Promise<MailboxBatch> {
    const argv = ["orchestration", "check", "--run", runId, "--types", o.types.join(",")];
    if (o.ack) argv.push("--ack", o.ack);
    if (o.wait) argv.push("--wait");
    argv.push("--timeout-ms", String(o.wait ? this.pollTimeoutMs : 1000));
    const r = await this.call(argv, Check, {
      signal: o.signal,
      timeoutMs: (o.wait ? this.pollTimeoutMs : 1000) + 20_000,
    });
    if (r.connectionLost)
      throw new OrcaCliError("orca lost its connection to the runtime", "connection_lost");
    return { deliveryId: r.deliveryId ?? null, messages: r.messages.map(toMessage) };
  }

  async capabilities() {
    const r = await this.call(["status"], Status);
    return { version: r.runtime?.appVersion, capabilities: r.runtime?.capabilities ?? [] };
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

/** Messages carry their lifecycle fields as a JSON *string* in `payload`; tolerate an object too. */
function toMessage(m: z.infer<typeof RawMessage>): OrcaMessage {
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
    type: m.type,
    subject: m.subject ?? undefined,
    body: m.body ?? undefined,
    dispatchId: payload.dispatchId,
    taskId: payload.taskId,
    outcome: payload.outcome,
    rejection: rej ? { code: rej.code ?? "rejected", reason: rej.reason } : undefined,
  };
}
