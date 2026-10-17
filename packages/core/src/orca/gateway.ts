import type { Liveness, Outcome } from "@heartwood/protocol";

export type Disposition = "reuse" | "retain" | "release";

/** One Orca mailbox message. Unknown optional fields are treated as absent. */
export interface OrcaMessage {
  id: string;
  /** worker_done | escalation | question | heartbeat | anything newer Orca adds */
  type: string;
  workerId?: string;
  outcome?: Outcome;
  summary?: string;
  text?: string;
}

export interface MailboxBatch {
  /** FIFO. Replayed by Orca until acked. May contain types that were not requested (e.g. heartbeats). */
  messages: OrcaMessage[];
}

export interface WorkerProjection {
  workerId: string;
  liveness: Liveness;
  attention?: string;
  nextAction?: string;
}

export interface StartWorkerInput {
  spec: string;
  agent: string;
  model?: string;
  effort?: string;
  name?: string;
  worktree: string;
  taskId?: string;
  /** Orca environment to run on (`--on`). */
  env?: string;
}

export interface CheckOptions {
  /** Message types that wake the long poll. Heartbeats are deliberately not in the default list. */
  types: readonly string[];
  /** Long-poll (`--wait`) when true; otherwise return immediately. */
  wait: boolean;
  signal?: AbortSignal;
}

/** Thrown by gateway implementations on CLI failure. */
export class OrcaCliError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number,
  ) {
    super(message);
  }
}

/**
 * Everything Heartwood needs from Orca. Implementations shell out to `orca … --json` (argv, no
 * shell; `orca.cmd` shims cannot be spawned without one, so use `orca.exe`). Heartwood is the
 * sole mailbox consumer per Run. If Orca gains a push stream, only this transport changes.
 */
export interface OrcaGateway {
  createRun(objective: string): Promise<{ runId: string }>;
  createTask(runId: string, t: { spec: string; deps?: string[] }): Promise<{ taskId: string }>;
  startWorker(runId: string, w: StartWorkerInput): Promise<{ workerId: string }>;
  listWorkers(runId: string): Promise<WorkerProjection[]>;
  readWorker(workerId: string, cursor?: string): Promise<{ text: string; cursor?: string }>;
  /** Settle the worker terminal: reuse, retain or release. */
  settleWorker(runId: string, workerId: string, disposition: Disposition): Promise<void>;
  /** Only call with positive proof that the worker should stop; a missing worker_done is not proof. */
  stopWorker(workerId: string): Promise<void>;
  check(runId: string, opts: CheckOptions): Promise<MailboxBatch>;
  /** Acknowledge consumed messages. Call only after their effects are durably committed. */
  ack(runId: string, messageIds: readonly string[]): Promise<void>;
  capabilities(): Promise<{ version?: string; commands: string[] }>;
}
