import type { Liveness } from "@heartwood/protocol";
import {
  BackendError,
  type BackendInfo,
  type BackendMessage,
  type Disposition,
  type PollBatch,
  type PollOptions,
  type SettleResult,
  type StartedWorker,
  type StartWorkerInput,
  type WorkerBackend,
  type WorkerInfo,
} from "./backend.js";

interface GroupBox {
  queue: BackendMessage[];
  delivery?: { token: string; messages: BackendMessage[] };
  waiters: (() => void)[];
}

/**
 * In-memory backend for tests. Mimics the contract coordinators rely on: FIFO mailbox delivered as
 * one whole batch with a token, replayed until that token is acked on a later poll, heartbeats included.
 */
export class FakeBackend implements WorkerBackend {
  readonly name = "fake";
  readonly calls: { method: string; args: unknown[] }[] = [];
  private seq = 0;
  private groups = new Map<string, GroupBox>();
  private workers = new Map<string, WorkerInfo & { groupRef: string }>();
  private failures = new Map<string, Error[]>();
  readonly dispositions = new Map<string, Disposition>();
  readonly stopped: string[] = [];
  readonly abandoned: string[] = [];
  /** Force the state settleWorker reports (e.g. "retained" for an unproven identity). */
  settleOverride?: SettleResult["state"];
  info: BackendInfo = { name: "fake", version: "0", compatible: true, problems: [] };

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    const f = this.failures.get(method)?.shift();
    if (f) throw f;
  }

  private box(groupRef: string): GroupBox {
    let b = this.groups.get(groupRef);
    if (!b) this.groups.set(groupRef, (b = { queue: [], waiters: [] }));
    return b;
  }

  /** Make the next call to `method` reject. */
  failNext(method: string, err: Error = new BackendError("boom", "internal", 1)): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), err]);
  }

  pushMessage(groupRef: string, m: BackendMessage): void {
    const b = this.box(groupRef);
    b.queue.push(m);
    for (const w of b.waiters.splice(0)) w();
  }

  setLiveness(workerRef: string, liveness: Liveness): void {
    const w = this.workers.get(workerRef);
    if (w) w.liveness = liveness;
  }

  /** Messages the backend would still deliver (current unacked batch plus queued). */
  pending(groupRef: string): BackendMessage[] {
    const b = this.box(groupRef);
    return [...(b.delivery?.messages ?? []), ...b.queue];
  }

  async open(): Promise<BackendInfo> {
    this.record("open");
    return this.info;
  }

  async createGroup(objective: string) {
    this.record("createGroup", objective);
    const groupRef = `group_${++this.seq}`;
    this.box(groupRef);
    return { groupRef };
  }

  readonly closedGroups: string[] = [];

  async closeGroup(groupRef: string) {
    this.record("closeGroup", groupRef);
    this.closedGroups.push(groupRef);
  }

  async createTask(groupRef: string, t: { spec: string; deps?: string[] }) {
    this.record("createTask", groupRef, t);
    return { taskRef: `task_${++this.seq}` };
  }

  async startWorker(groupRef: string, w: StartWorkerInput): Promise<StartedWorker> {
    this.record("startWorker", groupRef, w);
    const workerRef = `worker_${++this.seq}`;
    this.workers.set(workerRef, { workerRef, liveness: "live", groupRef });
    return {
      workerRef,
      taskRef: w.taskRef ?? `task_${++this.seq}`,
      locator: `loc_${workerRef}`,
      state: "running",
    };
  }

  async listWorkers(groupRef: string): Promise<WorkerInfo[]> {
    this.record("listWorkers", groupRef);
    return [...this.workers.values()]
      .filter((w) => w.groupRef === groupRef)
      .map(({ groupRef: _g, ...w }) => ({ ...w }));
  }

  async readWorker(workerRef: string, cursor?: string) {
    this.record("readWorker", workerRef, cursor);
    return { text: "", cursor };
  }

  async settleWorker(workerRef: string, disposition: Disposition): Promise<SettleResult> {
    this.record("settleWorker", workerRef, disposition);
    this.dispositions.set(workerRef, disposition);
    return { state: this.settleOverride ?? (disposition === "release" ? "released" : "retained") };
  }

  readonly replies: { groupRef: string; messageId: string; text: string }[] = [];

  async reply(groupRef: string, messageId: string, text: string) {
    this.record("reply", groupRef, messageId, text);
    this.replies.push({ groupRef, messageId, text });
  }

  async stopWorker(workerRef: string) {
    this.record("stopWorker", workerRef);
    this.stopped.push(workerRef);
  }

  async abandonWorker(workerRef: string) {
    this.record("abandonWorker", workerRef);
    this.abandoned.push(workerRef);
  }

  async poll(groupRef: string, opts: PollOptions): Promise<PollBatch> {
    this.record("poll", groupRef, opts);
    const b = this.box(groupRef);
    if (opts.ack && b.delivery?.token === opts.ack) b.delivery = undefined;
    if (!b.delivery && opts.wait && b.queue.length === 0) {
      await new Promise<void>((resolve) => {
        b.waiters.push(resolve);
        opts.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    if (!b.delivery && b.queue.length > 0)
      b.delivery = { token: `batch_${++this.seq}`, messages: b.queue.splice(0) };
    return { token: b.delivery?.token ?? null, messages: [...(b.delivery?.messages ?? [])] };
  }
}
