import { describe, expect, it } from "vitest";
import { OrcaBackend } from "./orcaBackend.js";

/**
 * Opt-in smoke test against a real, running Orca: `HEARTWOOD_ORCA_LIVE=1 pnpm test`.
 * Creates a throwaway group (Run) with its idle coordinator terminal and one task, then closes the
 * terminal. It never starts a worker.
 */
describe.skipIf(!process.env.HEARTWOOD_ORCA_LIVE)("live Orca", () => {
  const be = new OrcaBackend({ pollTimeoutMs: 1000 });

  it("is compatible", async () => {
    const info = await be.open();
    expect(info).toMatchObject({ name: "orca", compatible: true });
  });

  it("creates a group and task, long-polls an empty mailbox, lists no workers", async () => {
    const { groupRef } = await be.createGroup("heartwood live smoke (safe to delete)");
    expect(groupRef).toMatch(/^run_/);
    const { taskRef } = await be.createTask(groupRef, { spec: "smoke: nothing to do" });
    expect(taskRef).toMatch(/^task_/);
    const batch = await be.poll(groupRef, { wake: ["done", "escalation", "question"], wait: true });
    expect(batch).toEqual({ token: null, messages: [] });
    expect(await be.listWorkers(groupRef)).toEqual([]);
    await be.closeGroup(groupRef);
  });
});
