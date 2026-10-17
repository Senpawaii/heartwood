import { describe, expect, it } from "vitest";
import { getBodyByWorkerRef, getDispatch, getSoul } from "../queries.js";
import { makeTown } from "../testing.js";
import { BackendError, type BackendMessage } from "./backend.js";
import { BackendCoordinator, GroupLimitError } from "./coordinator.js";
import { FakeBackend } from "./fakeBackend.js";

async function setup(opts: ConstructorParameters<typeof BackendCoordinator>[2] = {}) {
  const t = makeTown();
  const be = new FakeBackend();
  const co = new BackendCoordinator(t.ctx, be, opts);
  const soul = t.addSoul("Oak");
  const { groupRef } = await be.createGroup("ship");
  const { warbandId } = t.formWarband(soul, [], groupRef);
  const start = async () => {
    const { workerRef } = await be.startWorker(groupRef, {
      spec: "s",
      agent: "claude",
      placement: "new-child",
    });
    const d = await t.dispatch(warbandId, soul, workerRef);
    return { workerRef, ...d };
  };
  return { t, be, co, soul, groupRef, warbandId, start };
}

const msg = (
  m: Partial<BackendMessage> & { id: string; kind: BackendMessage["kind"] },
): BackendMessage => ({
  rawType: m.kind,
  ...m,
});
const done = (id: string, workerRef: string, outcome: "succeeded" | "failed" = "succeeded") =>
  msg({ id, kind: "done", workerRef, outcome, text: "all good" });

const batchesOf = (be: FakeBackend) =>
  be.calls
    .filter((c) => c.method === "poll")
    .map((c) => c.args[1] as { ack?: string; wake: string[] });

async function waitFor(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("BackendCoordinator.pollOnce", () => {
  it("translates done into events, settles the dispatch, then releases the worker", async () => {
    const { t, be, co, groupRef, soul, start } = await setup();
    const w = await start();
    be.pushMessage(groupRef, done("m1", w.workerRef));

    expect(await co.pollOnce(groupRef)).toBe(true);

    expect(getDispatch(t.db, w.dispatchId)).toMatchObject({
      state: "settled",
      outcome: "succeeded",
    });
    expect(getSoul(t.db, soul, t.rules)?.xp).toBe(t.rules.xp.taskSuccess);
    expect(be.pending(groupRef)).toHaveLength(1); // acked on the next poll
    expect(be.dispositions.get(w.workerRef)).toBe("release");
    expect(getBodyByWorkerRef(t.db, w.workerRef)?.disposition).toBe("release");
    const types = t.log.read().map((e) => e.type);
    expect(types).toContain("backend.worker_done");
    expect(types).toContain("body.released");
  });

  it("drops heartbeats: acked and tracked in a projection, but never appended as events", async () => {
    const { t, be, co, groupRef, start } = await setup();
    const w = await start();
    be.pushMessage(groupRef, msg({ id: "h1", kind: "heartbeat", workerRef: w.workerRef }));
    be.pushMessage(groupRef, msg({ id: "h2", kind: "heartbeat", workerRef: w.workerRef }));
    const before = t.log.lastSeq();
    await co.pollOnce(groupRef);
    expect(t.log.lastSeq()).toBe(before);
    await co.pollOnce(groupRef); // carries the ack of the heartbeat-only batch
    expect(be.pending(groupRef)).toEqual([]);
    expect(
      t.db
        .prepare("SELECT COUNT(*) AS c FROM worker_heartbeats WHERE worker_ref = ?")
        .get(w.workerRef),
    ).toEqual({ c: 1 });
  });

  it("only wakes on done, escalation and question", async () => {
    const { be, co, groupRef } = await setup();
    await co.pollOnce(groupRef);
    expect(batchesOf(be)[0]?.wake).toEqual(["done", "escalation", "question"]);
  });

  it("acks a batch only on the next poll, after its effects were committed", async () => {
    const { t, be, co, groupRef, start } = await setup();
    const w = await start();
    be.pushMessage(groupRef, done("m1", w.workerRef));
    await co.pollOnce(groupRef);
    expect(getDispatch(t.db, w.dispatchId)?.state).toBe("settled");
    expect(be.pending(groupRef)).toHaveLength(1);
    await co.pollOnce(groupRef);
    const polls = batchesOf(be);
    expect(polls[0]?.ack).toBeUndefined();
    expect(polls[1]?.ack).toMatch(/^batch_/);
    expect(be.pending(groupRef)).toEqual([]);
  });

  it("is idempotent when the daemon restarts before acking and the backend replays the batch", async () => {
    const { t, be, co, groupRef, soul, start } = await setup();
    const w = await start();
    be.pushMessage(groupRef, done("m1", w.workerRef));
    await co.pollOnce(groupRef);
    const restarted = new BackendCoordinator(t.ctx, be); // loses the in-memory pending ack
    expect(await restarted.pollOnce(groupRef)).toBe(true); // replay of the same batch
    expect(getSoul(t.db, soul, t.rules)?.xp).toBe(t.rules.xp.taskSuccess); // not doubled
    expect(t.log.read({ types: ["backend.worker_done"] })).toHaveLength(1);
    expect(t.log.read({ types: ["dispatch.settled"] })).toHaveLength(1);
    expect(t.log.read({ types: ["backend.mailbox_batch"] })).toHaveLength(1);
    await restarted.pollOnce(groupRef);
    expect(be.pending(groupRef)).toEqual([]);
  });

  it("stop() flushes the pending ack", async () => {
    const { t, be, co, groupRef, start } = await setup({ livenessIntervalMs: 1e9 });
    const w = await start();
    co.start(groupRef);
    be.pushMessage(groupRef, done("m1", w.workerRef));
    await waitFor(() => getDispatch(t.db, w.dispatchId)?.state === "settled");
    await co.stop(groupRef);
    expect(be.pending(groupRef)).toEqual([]);
  });

  it("does not carry an ack forward when committing the batch fails", async () => {
    const { t, be, co, groupRef, start } = await setup();
    const w = await start();
    be.pushMessage(groupRef, done("m1", w.workerRef));
    t.db.exec(
      "CREATE TRIGGER boom BEFORE INSERT ON xp_ledger BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    expect(await co.pollOnce(groupRef)).toBe(false);
    expect(getDispatch(t.db, w.dispatchId)?.state).toBe("running"); // whole batch rolled back
    t.db.exec("DROP TRIGGER boom");
    expect(await co.pollOnce(groupRef)).toBe(true); // same batch replayed
    expect(batchesOf(be).every((c) => c.ack === undefined)).toBe(true);
    expect(getDispatch(t.db, w.dispatchId)?.state).toBe("settled");
  });

  it("never settles on a lifecycle message the backend rejected", async () => {
    const { t, be, co, groupRef, soul, start } = await setup();
    const w = await start();
    be.pushMessage(
      groupRef,
      msg({
        id: "m1",
        kind: "rejected",
        rawType: "worker_done",
        workerRef: w.workerRef,
        rejection: { code: "unknown_task", reason: "stale" },
      }),
    );
    be.pushMessage(
      groupRef,
      msg({
        id: "m2",
        kind: "rejected",
        rawType: "status",
        rejection: { code: "sender_not_assignee" },
      }),
    );
    await co.pollOnce(groupRef);
    expect(getDispatch(t.db, w.dispatchId)?.state).toBe("running");
    expect(getSoul(t.db, soul, t.rules)?.xp).toBe(0);
    expect(t.log.read({ types: ["backend.worker_done"] })).toEqual([]);
    expect(t.log.read({ types: ["backend.message_rejected"] }).map((e) => e.payload)).toMatchObject(
      [
        { messageId: "m1", code: "unknown_task", messageType: "worker_done" },
        { messageId: "m2", code: "sender_not_assignee" },
      ],
    );
  });

  it("records backend failures with a consecutive count and resets on success", async () => {
    const { t, be, co, groupRef } = await setup();
    be.failNext("poll", new BackendError("exit 1", "internal", 1));
    be.failNext("poll", new BackendError("exit 1", "internal", 1));
    expect(await co.pollOnce(groupRef)).toBe(false);
    expect(await co.pollOnce(groupRef)).toBe(false);
    expect(await co.pollOnce(groupRef)).toBe(true);
    be.failNext("poll");
    await co.pollOnce(groupRef);
    const counts = t.log
      .read({ types: ["backend.poll_failed"] })
      .map((e) => (e.payload as { consecutiveFailures: number }).consecutiveFailures);
    expect(counts).toEqual([1, 2, 1]);
  });

  it("records escalations, questions and unknown message kinds", async () => {
    const { t, be, co, groupRef, start } = await setup();
    const w = await start();
    be.pushMessage(
      groupRef,
      msg({ id: "e1", kind: "escalation", workerRef: w.workerRef, text: "blocked on creds" }),
    );
    be.pushMessage(
      groupRef,
      msg({ id: "q1", kind: "question", workerRef: w.workerRef, text: "which db?" }),
    );
    be.pushMessage(groupRef, msg({ id: "x1", kind: "other", rawType: "telepathy" }));
    await co.pollOnce(groupRef);
    expect(t.log.read({ types: ["escalation.raised"] })[0]?.payload).toMatchObject({
      level: "foreman",
      reason: "blocked on creds",
      dispatchId: w.dispatchId,
    });
    expect(t.log.read({ types: ["question.asked"] })[0]?.payload).toMatchObject({
      text: "which db?",
    });
    expect(t.log.read({ types: ["backend.unknown_message"] })[0]?.payload).toMatchObject({
      messageType: "telepathy",
    });
  });

  it("applies the configured disposition and retries a failed settleWorker on reconcile", async () => {
    const { t, be, co, groupRef, start } = await setup({
      disposition: (o) => (o === "succeeded" ? "retain" : "release"),
    });
    const w = await start();
    be.pushMessage(groupRef, done("m1", w.workerRef));
    be.failNext("settleWorker");
    await co.pollOnce(groupRef);
    expect(getBodyByWorkerRef(t.db, w.workerRef)?.disposition).toBeNull();
    await co.reconcile(groupRef);
    expect(be.dispositions.get(w.workerRef)).toBe("retain");
    expect(getBodyByWorkerRef(t.db, w.workerRef)?.disposition).toBe("retain");
  });
});

describe("BackendCoordinator release outcomes", () => {
  it("records body.retained, not released, when the backend could not prove the worker's identity", async () => {
    const { t, be, co, groupRef, start } = await setup();
    const w = await start();
    be.settleOverride = "retained";
    be.pushMessage(groupRef, done("m1", w.workerRef));
    await co.pollOnce(groupRef);
    expect(getBodyByWorkerRef(t.db, w.workerRef)?.disposition).toBe("retain");
    expect(t.log.read({ types: ["body.released"] })).toEqual([]);
  });

  it("records nothing while the backend is still releasing, then records the release once", async () => {
    const { t, be, co, groupRef, start } = await setup();
    const w = await start();
    be.settleOverride = "pending";
    be.pushMessage(groupRef, done("m1", w.workerRef));
    await co.pollOnce(groupRef);
    expect(getBodyByWorkerRef(t.db, w.workerRef)?.disposition).toBeNull();
    be.settleOverride = undefined;
    await co.reconcile(groupRef);
    await co.reconcile(groupRef);
    expect(t.log.read({ types: ["body.released"] })).toHaveLength(1);
  });
});

describe("BackendCoordinator.reconcile", () => {
  it("never treats a missing done or unverifiable liveness as death", async () => {
    const { t, be, co, groupRef, start } = await setup();
    const w = await start();
    be.setLiveness(w.workerRef, "unverifiable");
    await co.reconcile(groupRef);
    expect(getDispatch(t.db, w.dispatchId)?.state).toBe("running");
    expect(getBodyByWorkerRef(t.db, w.workerRef)?.liveness).toBe("unverifiable");
    expect(be.stopped).toEqual([]);
  });

  it("abandons a dispatch only on positive proof of exit, and releases the body", async () => {
    const { t, be, co, groupRef, soul, start } = await setup();
    const w = await start();
    be.setLiveness(w.workerRef, "exited");
    await co.reconcile(groupRef);
    expect(getDispatch(t.db, w.dispatchId)).toMatchObject({
      state: "settled",
      outcome: "abandoned",
    });
    expect(getSoul(t.db, soul, t.rules)?.xp).toBe(0);
    expect(getBodyByWorkerRef(t.db, w.workerRef)).toMatchObject({
      liveness: "exited",
      disposition: "release",
    });
    await co.reconcile(groupRef);
    expect(t.log.read({ types: ["body.liveness_changed"] })).toHaveLength(1);
  });

  it("a done that raced with exit wins over abandonment", async () => {
    const { t, be, co, groupRef, start } = await setup();
    const w = await start();
    be.pushMessage(groupRef, done("m1", w.workerRef, "failed"));
    be.setLiveness(w.workerRef, "exited");
    await co.reconcile(groupRef);
    expect(getDispatch(t.db, w.dispatchId)).toMatchObject({ outcome: "failed" });
  });
});

describe("BackendCoordinator group watching", () => {
  it("close() stops watching and has the backend release group-level resources", async () => {
    const { be, co, groupRef } = await setup({ livenessIntervalMs: 1e9 });
    co.start(groupRef);
    await co.close(groupRef);
    expect(co.watching).toEqual([]);
    expect(be.closedGroups).toEqual([groupRef]);
  });

  it("caps concurrently watched groups", async () => {
    const { co } = await setup({ maxConcurrentGroups: 2 });
    co.start("g1");
    co.start("g2");
    co.start("g2"); // idempotent
    expect(() => co.start("g3")).toThrow(GroupLimitError);
    await co.stopAll();
    expect(co.watching).toEqual([]);
  });

  it("long-polls: processes a message as it arrives and stops cleanly", async () => {
    const { t, be, co, groupRef, start } = await setup({ livenessIntervalMs: 1e9 });
    const w = await start();
    co.start(groupRef);
    be.pushMessage(groupRef, done("m1", w.workerRef));
    await waitFor(() => getDispatch(t.db, w.dispatchId)?.state === "settled");
    await co.stop(groupRef);
    expect(co.watching).toEqual([]);
  });

  it("backs off exponentially after failures", async () => {
    const delays: number[] = [];
    const { be, co, groupRef } = await setup({
      baseBackoffMs: 100,
      maxBackoffMs: 350,
      livenessIntervalMs: 1e9,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    for (let i = 0; i < 4; i++) be.failNext("poll");
    co.start(groupRef);
    await waitFor(() => delays.length >= 4);
    expect(delays.slice(0, 4)).toEqual([100, 200, 350, 350]);
    await co.stopAll();
  });

  it("resume() restarts active groups up to the cap and reports the rest as deferred", async () => {
    const t = makeTown();
    const be = new FakeBackend();
    const co = new BackendCoordinator(t.ctx, be, { maxConcurrentGroups: 2 });
    const soul = t.addSoul("Oak");
    t.formWarband(soul, [], "g1");
    t.formWarband(soul, [], "g2");
    t.formWarband(soul, [], "g3");
    expect(co.resume()).toEqual({ started: ["g1", "g2"], deferred: ["g3"] });
    await co.stopAll();
  });
});
