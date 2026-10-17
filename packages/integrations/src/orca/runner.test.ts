import { describe, expect, it } from "vitest";
import { execaRunner } from "./runner.js";

describe("execaRunner", () => {
  it("passes argv verbatim with no shell (quotes, spaces, group addresses survive)", async () => {
    const run = execaRunner(process.execPath);
    const tricky = ['a "b" c', "@all", "x,y", "$HOME", "--types=worker_done,escalation"];
    const r = await run(["-e", "console.log(JSON.stringify(process.argv.slice(1)))", ...tricky]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(tricky);
  });

  it("returns non-zero exits instead of throwing, so the JSON error envelope can be read", async () => {
    const r = await execaRunner(process.execPath)(["-e", 'console.log("{}"); process.exit(3)']);
    expect(r).toMatchObject({ exitCode: 3, stdout: "{}" });
  });

  it("reports a missing binary with a stable code", async () => {
    await expect(execaRunner("definitely-not-orca-xyz")(["--version"])).rejects.toMatchObject({
      code: "orca_not_found",
    });
  });

  it("refuses .cmd shims, which cannot be spawned without a shell", () => {
    expect(() => execaRunner("C:\\tools\\orca.cmd")).toThrow(/shell shim/);
  });

  it("aborts a running process", async () => {
    const ac = new AbortController();
    const p = execaRunner(process.execPath)(["-e", "setTimeout(()=>{}, 30000)"], {
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 100);
    expect((await p).exitCode).toBe(130);
  });
});
