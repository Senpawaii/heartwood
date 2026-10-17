import { OrcaCliError, OrcaStartError } from "@heartwood/core";
import { describe, expect, it } from "vitest";
import { OrcaCliGateway } from "./cliGateway.js";
import type { OrcaRunner } from "./runner.js";

const ok = (result: unknown) => ({
  exitCode: 0,
  stdout: JSON.stringify({ id: "x", ok: true, result }),
  stderr: "",
});
const fail = (code: string, message: string, exitCode = 1, result?: unknown) => ({
  exitCode,
  stdout: JSON.stringify({
    id: "x",
    ok: false,
    error: { code, message },
    ...(result ? { result } : {}),
  }),
  stderr: "",
});

/** Records argv and replies from a queue. */
function scripted(...replies: ReturnType<typeof ok>[]) {
  const calls: string[][] = [];
  const runner: OrcaRunner = async (argv) => {
    calls.push([...argv]);
    const r = replies.shift();
    if (!r) throw new Error("no scripted reply");
    return r;
  };
  return { calls, runner };
}

// Shapes below were captured from `orca` 1.4.200 (trimmed).
const rejectedBatch = {
  runId: "run_1",
  deliveryId: "delivery_6d78a492eecb",
  messages: [
    {
      id: "msg_9b15",
      run_id: "run_1",
      type: "status",
      subject: "Rejected escalation: Blocked: probe",
      body: "Orca rejected this escalation",
      payload:
        '{"taskId":"task_x","dispatchId":"disp_x","_orcaLifecycleRejection":{"code":"sender_not_assignee","reason":"No active Dispatch belongs to this message sender."}}',
    },
    {
      id: "msg_690a",
      type: "worker_done",
      subject: "done",
      body: "three sentences.",
      payload: '{"taskId":"task_1","dispatchId":"ctx_1","outcome":"succeeded"}',
    },
  ],
  count: 2,
  acknowledged: null,
  timedOut: false,
  cancelled: false,
  connectionLost: false,
};

describe("OrcaCliGateway.check", () => {
  it("builds the argv, parses string payloads, and surfaces lifecycle rejections", async () => {
    const { calls, runner } = scripted(ok(rejectedBatch));
    const gw = new OrcaCliGateway({ runner, pollTimeoutMs: 5000 });
    const batch = await gw.check("run_1", {
      types: ["worker_done", "escalation", "question"],
      wait: true,
      ack: "delivery_prev",
    });

    expect(calls[0]).toEqual([
      "orchestration",
      "check",
      "--run",
      "run_1",
      "--types",
      "worker_done,escalation,question",
      "--ack",
      "delivery_prev",
      "--wait",
      "--timeout-ms",
      "5000",
      "--json",
    ]);
    expect(batch.deliveryId).toBe("delivery_6d78a492eecb");
    expect(batch.messages[0]).toMatchObject({
      id: "msg_9b15",
      type: "status",
      dispatchId: "disp_x",
      rejection: { code: "sender_not_assignee" },
    });
    expect(batch.messages[1]).toMatchObject({
      type: "worker_done",
      dispatchId: "ctx_1",
      taskId: "task_1",
      outcome: "succeeded",
      body: "three sentences.",
    });
    expect(batch.messages[1]?.rejection).toBeUndefined();
  });

  it("returns a null delivery for an empty check and does not wait without --wait", async () => {
    const { calls, runner } = scripted(
      ok({ runId: "run_1", deliveryId: null, messages: [], timedOut: true }),
    );
    const batch = await new OrcaCliGateway({ runner }).check("run_1", {
      types: ["worker_done"],
      wait: false,
    });
    expect(batch).toEqual({ deliveryId: null, messages: [] });
    expect(calls[0]).not.toContain("--wait");
  });

  it("treats a lost runtime connection as a failure so nothing is acked", async () => {
    const { runner } = scripted(ok({ ...rejectedBatch, connectionLost: true }));
    await expect(
      new OrcaCliGateway({ runner }).check("run_1", { types: [], wait: false }),
    ).rejects.toMatchObject({ code: "connection_lost" });
  });

  it("tolerates unknown fields and an unparsable payload", async () => {
    const { runner } = scripted(
      ok({
        deliveryId: "d",
        future: 1,
        messages: [{ id: "m", type: "worker_done", payload: "{not json", newField: true }],
      }),
    );
    const b = await new OrcaCliGateway({ runner }).check("r", { types: [], wait: false });
    expect(b.messages[0]).toMatchObject({ id: "m", type: "worker_done" });
    expect(b.messages[0]?.dispatchId).toBeUndefined();
  });
});

describe("OrcaCliGateway commands", () => {
  it("passes --from only when a sender terminal is configured", async () => {
    const a = scripted(ok({ run: { id: "run_1" } }));
    await new OrcaCliGateway({ runner: a.runner }).createRun("obj");
    expect(a.calls[0]).toEqual(["orchestration", "run-create", "--objective", "obj", "--json"]);
    const b = scripted(ok({ run: { id: "run_2" } }));
    await new OrcaCliGateway({ runner: b.runner, senderTerminal: "term_x" }).createRun("obj");
    expect(b.calls[0]).toEqual([
      "orchestration",
      "run-create",
      "--objective",
      "obj",
      "--from",
      "term_x",
      "--json",
    ]);
  });

  it("explains a missing sender terminal via the Orca error code", async () => {
    const { runner } = scripted(fail("no_active_sender_terminal", "Pass --from <terminal-handle>"));
    await expect(new OrcaCliGateway({ runner }).createRun("o")).rejects.toMatchObject({
      code: "no_active_sender_terminal",
    });
  });

  it("creates tasks with a JSON deps array", async () => {
    const { calls, runner } = scripted(ok({ task: { id: "task_2" } }));
    const r = await new OrcaCliGateway({ runner }).createTask("run_1", {
      spec: "do it",
      deps: ["task_1"],
    });
    expect(r).toEqual({ taskId: "task_2" });
    expect(calls[0]).toEqual([
      "orchestration",
      "task-create",
      "--run",
      "run_1",
      "--spec",
      "do it",
      "--deps",
      '["task_1"]',
      "--json",
    ]);
  });

  it("starts a worker; an unobserved first turn is a started worker, not a failure", async () => {
    const { calls, runner } = scripted(
      ok({
        runId: "run_1",
        taskId: "task_1",
        dispatchId: "ctx_028b",
        state: "outcome_unknown",
        effects: [
          { kind: "worktree", action: "reused", id: "wt" },
          { kind: "terminal", role: "agent", action: "created", id: "term_d4de" },
          { kind: "dispatch_input", role: "agent", id: "term_d4de", state: "accepted" },
        ],
      }),
    );
    const w = await new OrcaCliGateway({ runner }).startWorker("run_1", {
      taskId: "task_1",
      agent: "claude",
      model: "opus",
      effort: "high",
      worktree: "new-child",
      name: "n",
      env: "devbox",
    });
    expect(w).toEqual({
      dispatchId: "ctx_028b",
      taskId: "task_1",
      terminalHandle: "term_d4de",
      state: "outcome_unknown",
    });
    expect(calls[0]).toEqual([
      "orchestration",
      "worker-start",
      "--run",
      "run_1",
      "--task",
      "task_1",
      "--worktree",
      "new-child",
      "--agent",
      "claude",
      "--model",
      "opus",
      "--effort",
      "high",
      "--name",
      "n",
      "--on",
      "devbox",
      "--json",
    ]);
  });

  it("reuses a terminal instead of launching an agent, and validates input", async () => {
    const { calls, runner } = scripted(ok({ taskId: "t", dispatchId: "ctx_2" }));
    const gw = new OrcaCliGateway({ runner });
    await gw.startWorker("r", {
      spec: "s",
      agent: "claude",
      worktree: "current",
      terminal: "term_a",
    });
    expect(calls[0]).toContain("--terminal");
    expect(calls[0]).not.toContain("--agent");
    await expect(gw.startWorker("r", { agent: "claude", worktree: "current" })).rejects.toThrow(
      /exactly one/,
    );
    await expect(
      gw.startWorker("r", { spec: "s", taskId: "t", agent: "claude", worktree: "current" }),
    ).rejects.toThrow(/exactly one/);
    await expect(
      gw.startWorker("r", { spec: "s", agent: "claude", worktree: "current", effort: "high" }),
    ).rejects.toThrow(/effort requires model/);
  });

  it("carries Orca's receipt when worker-start fails, so the caller never relaunches blindly", async () => {
    const { runner } = scripted(
      fail("worker_start_failed", "terminal did not start", 1, {
        failedStage: "terminal_create",
        residualResources: [{ kind: "worktree", id: "wt" }],
      }),
    );
    const err = await new OrcaCliGateway({ runner })
      .startWorker("r", { spec: "s", agent: "claude", worktree: "new-child" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(OrcaStartError);
    expect(err).toMatchObject({
      code: "worker_start_failed",
      failedStage: "terminal_create",
      residualResources: [{ kind: "worktree", id: "wt" }],
    });
  });

  const row = (id: string, verdict?: string) => ({
    dispatchId: id,
    taskId: "t",
    agentTerminalHandle: `term_${id}`,
    projection: {
      liveness: verdict ? { verdict, reason: "x" } : undefined,
      attention: { categories: ["unverifiable"], requiresAction: true },
    },
  });

  it("maps liveness; anything unreadable is unverifiable, never exited; follows pagination", async () => {
    const { calls, runner } = scripted(
      ok({
        workers: [row("ctx_1", "live"), row("ctx_2", "exited")],
        page: { hasMore: true, nextCursor: "c2" },
      }),
      ok({
        workers: [row("ctx_3", "weird-new-verdict"), row("ctx_4")],
        page: { hasMore: false, nextCursor: null },
      }),
    );
    const ws = await new OrcaCliGateway({ runner }).listWorkers("run_1");
    expect(ws.map((w) => [w.dispatchId, w.liveness])).toEqual([
      ["ctx_1", "live"],
      ["ctx_2", "exited"],
      ["ctx_3", "unverifiable"],
      ["ctx_4", "unverifiable"],
    ]);
    expect(ws[0]).toMatchObject({
      terminalHandle: "term_ctx_1",
      attention: { categories: ["unverifiable"], requiresAction: true },
    });
    expect(calls[1]).toContain("c2");
  });

  it("reports what Orca actually did on release/retain", async () => {
    const run = async (state: string, extra = {}) => {
      const { runner } = scripted(ok({ dispatchId: "d", state, ...extra }));
      return new OrcaCliGateway({ runner }).settleWorker("d", "release");
    };
    expect(await run("released")).toEqual({ state: "released" });
    expect(await run("already_released")).toEqual({ state: "released" });
    expect(await run("release_pending")).toEqual({ state: "pending" });
    expect(await run("retained", { reason: "identity_unproven" })).toEqual({
      state: "retained",
      reason: "identity_unproven",
    });
    await expect(run("release_unknown")).rejects.toMatchObject({ code: "unexpected_state" });
    const { calls, runner } = scripted(ok({ state: "retained" }));
    await new OrcaCliGateway({ runner }).settleWorker("d", "retain");
    expect(calls[0]).toEqual(["orchestration", "worker-retain", "--dispatch", "d", "--json"]);
  });

  it("propagates Orca error codes and rejects non-JSON output", async () => {
    await expect(
      new OrcaCliGateway({
        runner: scripted(fail("dispatch_not_found", "nope")).runner,
      }).stopWorker("ctx_x"),
    ).rejects.toMatchObject({
      code: "dispatch_not_found",
      exitCode: 1,
    });
    const bad: OrcaRunner = async () => ({ exitCode: 2, stdout: "Usage: orca ...", stderr: "" });
    await expect(new OrcaCliGateway({ runner: bad }).abandonWorker("x")).rejects.toBeInstanceOf(
      OrcaCliError,
    );
  });

  it("reads terminal output and capabilities", async () => {
    const { runner } = scripted(
      ok({ cursor: "c9", terminal: { tail: ["a", "b"] } }),
      ok({ runtime: { appVersion: "1.4.200", capabilities: ["orchestration.contract.v1"] } }),
    );
    const gw = new OrcaCliGateway({ runner });
    expect(await gw.readWorker("d")).toEqual({ text: "a\nb", cursor: "c9" });
    expect(await gw.capabilities()).toEqual({
      version: "1.4.200",
      capabilities: ["orchestration.contract.v1"],
    });
  });
});
