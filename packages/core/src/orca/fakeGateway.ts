import type { Liveness } from "@heartwood/protocol";
import {
  type CheckOptions,
  type Disposition,
  type MailboxBatch,
  OrcaCliError,
  type OrcaGateway,
  type OrcaMessage,
  type StartWorkerInput,
  type WorkerProjection,
} from "./gateway.js";

/** In-memory Orca for tests. Mimics: FIFO mailbox, replay until ack, heartbeats always included. */
export class FakeOrcaGateway implements OrcaGateway {
  readonly calls: { method: string; args: unknown[] }[] = [];
  private runs = 0;
  private tasks = 0;
  private workers = new Map<string, WorkerProjection & { runId: string }>();
  private mailbox = new Map<string, OrcaMessage[]>();
  private waiters = new Map<string, (() => void)[]>();
  private failures = new Map<string, Error[]>();
  readonly dispositions = new Map<string, Disposition>();
  readonly stopped: string[] = [];

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    const f = this.failures.get(method)?.shift();
    if (f) throw f;
  }

  /** Make the next call to `method` reject. */
  failNext(method: string, err: Error = new OrcaCliError("boom", 1)): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), err]);
  }

  pushMessage(runId: string, m: OrcaMessage): void {
    this.mailbox.set(runId, [...(this.mailbox.get(runId) ?? []), m]);
    for (const w of this.waiters.get(runId)?.splice(0) ?? []) w();
  }

  setLiveness(workerId: string, liveness: Liveness): void {
    const w = this.workers.get(workerId);
    if (w) w.liveness = liveness;
  }

  pending(runId: string): OrcaMessage[] {
    return this.mailbox.get(runId) ?? [];
  }

  async createRun(objective: string) {
    this.record("createRun", objective);
    const runId = `run_${++this.runs}`;
    this.mailbox.set(runId, []);
    return { runId };
  }

  async createTask(runId: string, t: { spec: string; deps?: string[] }) {
    this.record("createTask", runId, t);
    return { taskId: `task_${++this.tasks}` };
  }

  async startWorker(runId: string, w: StartWorkerInput) {
    this.record("startWorker", runId, w);
    const workerId = `w_${this.workers.size + 1}`;
    this.workers.set(workerId, { workerId, liveness: "live", runId });
    return { workerId };
  }

  async listWorkers(runId: string): Promise<WorkerProjection[]> {
    this.record("listWorkers", runId);
    return [...this.workers.values()]
      .filter((w) => w.runId === runId)
      .map(({ runId: _r, ...w }) => ({ ...w }));
  }

  async readWorker(workerId: string, cursor?: string) {
    this.record("readWorker", workerId, cursor);
    return { text: "", cursor };
  }

  async settleWorker(runId: string, workerId: string, disposition: Disposition) {
    this.record("settleWorker", runId, workerId, disposition);
    this.dispositions.set(workerId, disposition);
  }

  async stopWorker(workerId: string) {
    this.record("stopWorker", workerId);
    this.stopped.push(workerId);
  }

  async check(runId: string, opts: CheckOptions): Promise<MailboxBatch> {
    this.record("check", runId, opts);
    if (opts.wait && this.pending(runId).length === 0) {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        this.waiters.set(runId, [...(this.waiters.get(runId) ?? []), done]);
        opts.signal?.addEventListener("abort", done, { once: true });
      });
    }
    return { messages: [...this.pending(runId)] };
  }

  async ack(runId: string, ids: readonly string[]) {
    this.record("ack", runId, ids);
    const gone = new Set(ids);
    this.mailbox.set(
      runId,
      this.pending(runId).filter((m) => !gone.has(m.id)),
    );
  }

  async capabilities() {
    return { version: "fake", commands: ["orchestration"] };
  }
}
