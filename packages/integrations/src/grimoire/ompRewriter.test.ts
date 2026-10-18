import type { BenchResult, Skill } from "@grimoire/core";
import { describe, expect, it } from "vitest";
import {
  type BasisView,
  createOmpRewriter,
  failureSummary,
  type OmpExec,
  OmpRewriteError,
  rewritePrompt,
} from "./ompRewriter.js";

const trial = (status: string, failing: string[] = []) => ({
  status,
  assertions: [
    { type: "file_exists", passed: true, detail: "ok" },
    ...failing.map((d) => ({ type: "file_contains", passed: false, detail: d })),
  ],
});
const basis: BasisView = {
  arms: [
    {
      label: "baseline",
      tasks: [{ taskId: "t", trials: [trial("completed", ["baseline-only"])] }],
    },
    {
      label: "with-skill",
      tasks: [
        {
          taskId: "greeting",
          trials: [
            trial("completed"),
            trial("completed", ["no ZEBRA"]),
            trial("completed", ["no ZEBRA"]),
          ],
        },
        { taskId: "clean", trials: [trial("completed")] },
        { taskId: "broken", trials: [trial("timeout")] },
      ],
    },
  ],
};
// the rewriter only reads name and, through the prompt, the basis
const skill = { name: "greeter" } as Skill;
const asResult = (b: BasisView) => b as unknown as BenchResult;

describe("failureSummary", () => {
  it("describes the skill arm's failures per task and ignores the baseline arm", () => {
    const s = failureSummary(basis);
    expect(s).toContain("task greeting: 2 of 3 trials failed (file_contains: no ZEBRA)");
    expect(s).toContain("task clean: all 1 trials passed");
    expect(s).toContain("task broken: 1 of 1 trials failed (trial timeout)");
    expect(s).not.toContain("baseline-only");
  });

  it("copes with a result that has no arms", () => {
    expect(failureSummary({ arms: [] })).toBe("No trials were recorded.");
  });
});

describe("createOmpRewriter", () => {
  const record = (reply: { exitCode?: number; stdout?: string; stderr?: string }) => {
    const calls: { argv: readonly string[]; prompt: string; cwd: string }[] = [];
    const exec: OmpExec = async (argv, prompt, cwd) => {
      calls.push({ argv, prompt, cwd });
      return {
        exitCode: reply.exitCode ?? 0,
        stdout: reply.stdout ?? "",
        stderr: reply.stderr ?? "",
      };
    };
    return { calls, exec };
  };

  it("runs omp headless and isolated in the candidate directory, with the failures in the prompt", async () => {
    const { calls, exec } = record({ stdout: "Added the exact file content.\n" });
    const out = await createOmpRewriter({ model: "anthropic/claude-sonnet-5-5:high", exec })(
      skill,
      asResult(basis),
      "/stage/greeter",
    );
    expect(out).toEqual({ changelog: "Added the exact file content." });
    const [c] = calls;
    expect(c?.cwd).toBe("/stage/greeter");
    expect(c?.argv).toEqual([
      "-p",
      "--no-session",
      "--approval-mode",
      "yolo",
      "--no-rules",
      "--no-extensions",
      "--no-skills",
      "--model",
      "anthropic/claude-sonnet-5-5:high",
    ]);
    expect(c?.prompt).toBe(rewritePrompt("greeter", basis));
    expect(c?.prompt).toContain("2 of 3 trials failed");
  });

  it("uses omp's default model when none is configured, and the last line of the reply as the changelog", async () => {
    const { calls, exec } = record({ stdout: "thinking...\n\nTightened the trigger.\n" });
    const out = await createOmpRewriter({ exec })(skill, asResult(basis), "/s");
    expect(out.changelog).toBe("Tightened the trigger.");
    expect(calls[0]?.argv).not.toContain("--model");
  });

  it("still returns a changelog when omp says nothing", async () => {
    const { exec } = record({ stdout: "  \n" });
    expect((await createOmpRewriter({ exec })(skill, asResult(basis), "/s")).changelog).toBe(
      "Rewritten by omp.",
    );
  });

  it("fails loudly, with omp's own message, when omp exits non-zero", async () => {
    const { exec } = record({ exitCode: 2, stderr: "model not found: nope" });
    const err = await createOmpRewriter({ exec })(skill, asResult(basis), "/s").catch((e) => e);
    expect(err).toBeInstanceOf(OmpRewriteError);
    expect(err.message).toBe("omp exited with 2: model not found: nope");
  });

  it("rejects a model id that is not plain provider/model syntax before running anything", () => {
    for (const bad of ["x; rm -rf /", "$(id)", "a b", "--thinking", ""])
      expect(() => createOmpRewriter({ model: bad })).toThrow(OmpRewriteError);
  });
});
