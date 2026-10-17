import type { Liveness } from "@heartwood/protocol";
import {
  type CheckOptions,
  type Disposition,
  type MailboxBatch,
  OrcaCliError,
  type OrcaGateway,
  type OrcaMessage,
  type SettleResult,
  type StartedWorker,
  type StartWorkerInput,
  type WorkerProjection,
} from "./gateway.js";

interface RunBox {
  queue: OrcaMessage[];
  delivery?: { id: string; messages: OrcaMessage[] };
  waiters: (() => void)[];
}

/**
 * In-memory Orca for tests. Mimics the verified behaviour: FIFO mailbox delivered as one whole
 * batch with a delivery id, replayed until that id is acked on the next check, heartbeats included.
 */
export class FakeOrcaGateway implements OrcaGateway {
  readonly calls: { method: string; args: unknown[] }[] = [];
  private seq = 0;
  private runs = new Map<string, RunBox>();
  private workers = new Map<string, WorkerProjection & { runId: string }>();
  private failures = new Map<string, Error[]>();
  readonly dispositions = new Map<string, Disposition>();
  readonly stopped: string[] = [];
  /** Force the state settleWorker reports (e.g. "retained" for an unproven identity). */
  settleOverride?: SettleResult["state"];
  readonly abandoned: string[] = [];

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    const f = this.failures.get(method)?.shift();
    if (f) throw f;
  }

  private box(runId: string): RunBox {
    let b = this.runs.get(runId);
    if (!b) this.runs.set(runId, (b = { queue: [], waiters: [] }));
    return b;
  }

  /** Make the next call to `method` reject. */
  failNext(method: string, err: Error = new OrcaCliError("boom", "internal", 1)): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), err]);
  }

  pushMessage(runId: string, m: OrcaMessage): void {
    const b = this.box(runId);
    b.queue.push(m);
    for (const w of b.waiters.splice(0)) w();
  }

  setLiveness(dispatchId: string, liveness: Liveness): void {
    const w = this.workers.get(dispatchId);
    if (w) w.liveness = liveness;
  }

  /** Messages Orca would still deliver (current unacked delivery plus queued). */
  pending(runId: string): OrcaMessage[] {
    const b = this.box(runId);
    return [...(b.delivery?.messages ?? []), ...b.queue];
  }

  async createRun(objective: string) {
    this.record("createRun", objective);
    const runId = `run_${++this.seq}`;
    this.box(runId);
    return { runId };
  }

  async createTask(runId: string, t: { spec: string; deps?: string[] }) {
    this.record("createTask", runId, t);
    return { taskId: `task_${++this.seq}` };
  }

  async startWorker(runId: string, w: StartWorkerInput): Promise<StartedWorker> {
    this.record("startWorker", runId, w);
    const dispatchId = `ctx_${++this.seq}`;
    this.workers.set(dispatchId, { dispatchId, liveness: "live", runId });
    return {
      dispatchId,
      taskId: w.taskId ?? `task_${++this.seq}`,
      terminalHandle: `term_${dispatchId}`,
      state: "running",
    };
  }

  async listWorkers(runId: string): Promise<WorkerProjection[]> {
    this.record("listWorkers", runId);
    return [...this.workers.values()]
      .filter((w) => w.runId === runId)
      .map(({ runId: _r, ...w }) => ({ ...w }));
  }

  async readWorker(dispatchId: string, cursor?: string) {
    this.record("readWorker", dispatchId, cursor);
    return { text: "", cursor };
  }

  async settleWorker(dispatchId: string, disposition: Disposition): Promise<SettleResult> {
    this.record("settleWorker", dispatchId, disposition);
    this.dispositions.set(dispatchId, disposition);
    return { state: this.settleOverride ?? (disposition === "release" ? "released" : "retained") };
  }

  async stopWorker(dispatchId: string) {
    this.record("stopWorker", dispatchId);
    this.stopped.push(dispatchId);
  }

  async abandonWorker(dispatchId: string) {
    this.record("abandonWorker", dispatchId);
    this.abandoned.push(dispatchId);
  }

  async check(runId: string, opts: CheckOptions): Promise<MailboxBatch> {
    this.record("check", runId, opts);
    const b = this.box(runId);
    if (opts.ack && b.delivery?.id === opts.ack) b.delivery = undefined;
    if (!b.delivery && opts.wait && b.queue.length === 0) {
      await new Promise<void>((resolve) => {
        b.waiters.push(resolve);
        opts.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    if (!b.delivery && b.queue.length > 0)
      b.delivery = { id: `delivery_${++this.seq}`, messages: b.queue.splice(0) };
    return { deliveryId: b.delivery?.id ?? null, messages: [...(b.delivery?.messages ?? [])] };
  }

  async capabilities() {
    return { version: "fake", capabilities: ["orchestration.contract.v1"] };
  }
}
