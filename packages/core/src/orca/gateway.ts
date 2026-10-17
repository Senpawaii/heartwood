import type { Liveness, Outcome } from "@heartwood/protocol";

/** What to do with a settled worker terminal. (Reuse = start the next Task on the same terminal via `startWorker({ terminal })`.) */
export type Disposition = "retain" | "release";

/**
 * What Orca actually did. A release request can end `retained` (e.g. the terminal identity was not
 * proven) or `pending`; only `released` may be recorded as released.
 */
export interface SettleResult {
  state: "released" | "retained" | "pending";
  reason?: string;
}

/** Orca's refusal of a lifecycle message (stale/unknown dispatch, wrong sender, …). Settles nothing. */
export interface OrcaRejection {
  code: string;
  reason?: string;
}

/** One Orca mailbox message, parsed. Unknown optional fields are treated as absent. */
export interface OrcaMessage {
  id: string;
  /** worker_done | escalation | question | heartbeat | status | anything newer Orca adds */
  type: string;
  subject?: string;
  body?: string;
  /** Orca Dispatch id (`ctx_…`) from the message payload; this is how Orca addresses a worker. */
  dispatchId?: string;
  taskId?: string;
  outcome?: Outcome;
  rejection?: OrcaRejection;
}

export interface MailboxBatch {
  /** Orca replays this whole FIFO delivery until it is acked. Null when nothing was delivered. */
  deliveryId: string | null;
  /** May contain types that were not in the wake list; the wake list only controls waking. */
  messages: OrcaMessage[];
}

export interface WorkerProjection {
  dispatchId: string;
  taskId?: string;
  /** Fleet verdict (`projection.liveness.verdict`). `unverifiable` is absence, never death. */
  liveness: Liveness;
  terminalHandle?: string;
  attention?: { categories: string[]; requiresAction: boolean };
}

export interface StartWorkerInput {
  /** Exactly one of `spec` (creates the Task) or `taskId` (existing Task, e.g. from a DAG). */
  spec?: string;
  taskId?: string;
  agent: string;
  model?: string;
  effort?: string;
  /** Worktree selector: `current`, `new-child`, `new-top-level`, or an explicit selector. */
  worktree: string;
  name?: string;
  /** Saved Orca environment to run on (`--on`). */
  env?: string;
  /** Reuse a proven agent terminal instead of launching a fresh one. */
  terminal?: string;
}

export interface StartedWorker {
  dispatchId: string;
  taskId: string;
  terminalHandle?: string;
  /**
   * Orca's start state (e.g. `outcome_unknown` when the agent's first turn could not be observed).
   * That is not a failure: the Dispatch settles normally if the worker reports.
   */
  state: string;
}

export interface CheckOptions {
  /** Message types that wake the long poll. Heartbeats are deliberately not in the default list. */
  types: readonly string[];
  /** Long-poll (`--wait`) when true; otherwise return immediately. */
  wait: boolean;
  /** Delivery id of the previous batch to acknowledge before checking. */
  ack?: string;
  signal?: AbortSignal;
}

/** Thrown by gateway implementations on CLI failure. */
export class OrcaCliError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly exitCode?: number,
  ) {
    super(message);
  }
}

/** `worker-start` failed. Carries Orca's receipt so the caller can recover; never relaunch blindly. */
export class OrcaStartError extends OrcaCliError {
  constructor(
    message: string,
    code: string | undefined,
    exitCode: number | undefined,
    readonly failedStage?: string,
    readonly residualResources: unknown[] = [],
  ) {
    super(message, code, exitCode);
  }
}

/**
 * Everything Heartwood needs from Orca. Implementations shell out to `orca … --json` (argv, no
 * shell; `orca.cmd` shims cannot be spawned without one). Heartwood is the sole mailbox consumer
 * per Run. Orca acks a whole delivery by id on the *next* `check`, so there is no separate ack
 * call. If Orca gains a push stream, only this transport changes.
 */
export interface OrcaGateway {
  createRun(objective: string): Promise<{ runId: string }>;
  createTask(runId: string, t: { spec: string; deps?: string[] }): Promise<{ taskId: string }>;
  startWorker(runId: string, w: StartWorkerInput): Promise<StartedWorker>;
  listWorkers(runId: string): Promise<WorkerProjection[]>;
  readWorker(dispatchId: string, cursor?: string): Promise<{ text: string; cursor?: string }>;
  /** Retain or release a worker whose Dispatch has settled. Idempotent. */
  settleWorker(dispatchId: string, disposition: Disposition): Promise<SettleResult>;
  /** Only with positive proof of exit; a missing worker_done is not proof. */
  stopWorker(dispatchId: string): Promise<void>;
  /** Fence a Dispatch without claiming its process stopped (safe when liveness is unverifiable). */
  abandonWorker(dispatchId: string): Promise<void>;
  check(runId: string, opts: CheckOptions): Promise<MailboxBatch>;
  capabilities(): Promise<{ version?: string; capabilities: string[] }>;
}
