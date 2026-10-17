import type { Liveness, Outcome } from "@heartwood/protocol";

/**
 * The port between Heartwood and whatever actually runs workers. Orca is the first adapter; the
 * daemon, coordinator and domain code depend only on this file. Adapter quirks (how identity is
 * provisioned, how deliveries are acked, vendor message types) stay inside the adapter.
 *
 * Vocabulary: a *group* is a team's namespace and mailbox (Orca: Run); a *worker* is one
 * attempt at a task (Orca: Dispatch). Refs are opaque strings owned by the backend.
 */

/** What to do with a settled worker. (Reuse = start the next task on the same worker via `startWorker({ reuse })`.) */
export type Disposition = "retain" | "release";

/** What the backend actually did. A release can end `retained` or `pending`; only `released` may be recorded as released. */
export interface SettleResult {
  state: "released" | "retained" | "pending";
  reason?: string;
}

export interface Rejection {
  code: string;
  reason?: string;
}

/** Neutral message kinds. Adapters translate their vendor types into these. */
export type MessageKind = "done" | "escalation" | "question" | "heartbeat" | "rejected" | "other";

/** Kinds that should wake a long poll. Heartbeats are deliberately excluded. */
export const WAKE_KINDS: readonly MessageKind[] = ["done", "escalation", "question"];

export interface BackendMessage {
  /** Unique within the backend; used to make replays idempotent. */
  id: string;
  kind: MessageKind;
  /** The backend's own message type, kept for diagnosis. */
  rawType: string;
  /** Ref of the worker this message concerns, if any. */
  workerRef?: string;
  taskRef?: string;
  /** Present for `done`. */
  outcome?: Outcome;
  text?: string;
  /** Present for `rejected`: the backend refused a lifecycle message; it must settle nothing. */
  rejection?: Rejection;
}

export interface PollBatch {
  /**
   * Token identifying this whole batch. The backend replays the batch until the token is passed
   * as `ack` on a later poll. Null when nothing was delivered.
   */
  token: string | null;
  messages: BackendMessage[];
}

export interface PollOptions {
  wake: readonly MessageKind[];
  /** Long-poll when true; otherwise return immediately. */
  wait: boolean;
  /** Token of the previously committed batch to acknowledge. */
  ack?: string;
  signal?: AbortSignal;
}

export interface WorkerInfo {
  workerRef: string;
  taskRef?: string;
  /** `unverifiable` is absence of information, never proof of exit. */
  liveness: Liveness;
  locator?: string;
  attention?: { categories: string[]; requiresAction: boolean };
}

export interface StartWorkerInput {
  /** Exactly one of `spec` (creates the task) or `taskRef` (existing task, e.g. from a DAG). */
  spec?: string;
  taskRef?: string;
  agent: string;
  model?: string;
  effort?: string;
  /** Placement: `current`, `new-child`, `new-top-level`, or a backend-specific selector. */
  placement: string;
  name?: string;
  /** Named execution environment to run on, if the backend has them. */
  environment?: string;
  /** Reuse a proven worker (its locator) instead of launching a fresh one. */
  reuse?: string;
}

export interface StartedWorker {
  workerRef: string;
  taskRef: string;
  locator?: string;
  /**
   * Backend start state (Orca: `outcome_unknown` when the first turn could not be observed).
   * Informational: liveness, not this, decides whether a worker is dead.
   */
  state: string;
}

export interface BackendInfo {
  name: string;
  version?: string;
  /** False when the backend lacks something Heartwood requires; see `problems`. */
  compatible: boolean;
  problems: string[];
}

/** Thrown by adapters on failure. `code` is a stable adapter-defined string. */
export class BackendError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly exitCode?: number,
  ) {
    super(message);
  }
}

/** Starting a worker failed. Carries the backend's receipt so the caller can recover; never relaunch blindly. */
export class WorkerStartError extends BackendError {
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

export interface WorkerBackend {
  readonly name: string;
  /** Provision whatever identity/connection the adapter needs and verify compatibility. Idempotent. */
  open(): Promise<BackendInfo>;
  createGroup(objective: string): Promise<{ groupRef: string }>;
  /** Release whatever the adapter holds for a finished group (e.g. its coordinator identity). Idempotent. */
  closeGroup(groupRef: string): Promise<void>;
  createTask(groupRef: string, t: { spec: string; deps?: string[] }): Promise<{ taskRef: string }>;
  startWorker(groupRef: string, w: StartWorkerInput): Promise<StartedWorker>;
  listWorkers(groupRef: string): Promise<WorkerInfo[]>;
  readWorker(workerRef: string, cursor?: string): Promise<{ text: string; cursor?: string }>;
  /** Retain or release a worker whose task has settled. Idempotent. */
  settleWorker(workerRef: string, disposition: Disposition): Promise<SettleResult>;
  /** Only with positive proof of exit; a missing `done` message is not proof. */
  stopWorker(workerRef: string): Promise<void>;
  /** Fence a worker without claiming its process stopped (safe when liveness is unverifiable). */
  abandonWorker(workerRef: string): Promise<void>;
  /** Answer a worker's question (the `messageId` of a `question` message). */
  reply(groupRef: string, messageId: string, text: string): Promise<void>;
  poll(groupRef: string, opts: PollOptions): Promise<PollBatch>;
}
