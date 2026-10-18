import type { SkillRewriter } from "@grimoire/core";
import { execa } from "execa";
import { resolveBinary } from "../orca/runner.js";

/** What running omp once produced. */
export interface OmpRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs omp with `argv`, `prompt` on stdin and `cwd` as its working directory. Injected so tests need no model. */
export type OmpExec = (
  argv: readonly string[],
  prompt: string,
  cwd: string,
  timeoutMs: number,
) => Promise<OmpRun>;

export interface OmpRewriterOptions {
  /** Model id, with an optional `:level` effort suffix (`anthropic/claude-sonnet-5-5:high`). */
  model?: string;
  bin?: string;
  /** Default 10 minutes. */
  timeoutMs?: number;
  exec?: OmpExec;
}

export class OmpRewriteError extends Error {}

const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._/@+:-]*$/;
const CHANGELOG_FALLBACK = "Rewritten by omp.";

/** The part of a `BenchResult` the prompt reads; a real result satisfies it. */
export interface BasisView {
  arms: {
    label: string;
    tasks: {
      taskId: string;
      trials: { status: string; assertions: { type: string; passed: boolean; detail: string }[] }[];
    }[];
  }[];
}

/** What failed, in words the rewriter can act on: the skill arm's failing assertions, one line per task. */
export function failureSummary(basis: BasisView): string {
  const arm = basis.arms.find((a) => a.label !== "baseline") ?? basis.arms[0];
  if (!arm) return "No trials were recorded.";
  const lines: string[] = [];
  for (const task of arm.tasks) {
    const failed = new Map<string, string>();
    for (const trial of task.trials) {
      if (trial.status !== "completed") failed.set(`trial ${trial.status}`, trial.status);
      for (const a of trial.assertions) if (!a.passed) failed.set(`${a.type}: ${a.detail}`, a.type);
    }
    const total = task.trials.length;
    const bad = task.trials.filter(
      (t) => t.status !== "completed" || t.assertions.some((a) => !a.passed),
    ).length;
    lines.push(
      bad === 0
        ? `- task ${task.taskId}: all ${total} trials passed`
        : `- task ${task.taskId}: ${bad} of ${total} trials failed (${[...failed.keys()].join("; ")})`,
    );
  }
  return lines.join("\n");
}

export function rewritePrompt(skillName: string, basis: BasisView): string {
  return [
    `You are improving the agent skill "${skillName}". Its files are in the current directory.`,
    "",
    "A benchmark ran an agent with this skill. Results per task:",
    failureSummary(basis),
    "",
    "Edit SKILL.md (and only files inside this directory) so the agent would pass those tasks.",
    "Keep the frontmatter `name` unchanged and keep the skill general: do not special-case the benchmark.",
    "Do not create benchmark suites, changelogs or notes in this directory.",
    "When done, reply with ONE line (no markdown) saying what you changed and why.",
  ].join("\n");
}

const execOmp = (bin: string): OmpExec => {
  let resolved: string | undefined;
  return async (argv, prompt, cwd, timeoutMs) => {
    resolved ??= resolveBinary(bin);
    const r = await execa(resolved, [...argv], {
      cwd,
      input: prompt,
      reject: false,
      shell: false,
      windowsHide: true,
      timeout: timeoutMs,
    });
    return { exitCode: r.exitCode ?? 1, stdout: String(r.stdout), stderr: String(r.stderr) };
  };
};

/**
 * A `SkillRewriter` that has omp edit the staged candidate directory: one headless, session-less omp
 * run with no user skills, rules or extensions, so the edit depends only on the prompt.
 *
 * omp runs unattended (`--approval-mode yolo`) with the candidate directory as its working directory.
 * That is a convenience boundary, not a sandbox: a rewriter that ignores the prompt could write
 * elsewhere. Run the daemon as a user that may lose nothing it should not.
 *
 * It does not check that anything changed: grimoire's `proposeVersion` throws `NoChange` when the
 * staged digest is unchanged, and the gate decides whether the new version is better.
 */
export function createOmpRewriter(o: OmpRewriterOptions = {}): SkillRewriter {
  if (o.model !== undefined && !SAFE_MODEL.test(o.model))
    throw new OmpRewriteError(`unsupported characters in model id "${o.model}"`);
  const exec = o.exec ?? execOmp(o.bin ?? "omp");
  const timeoutMs = o.timeoutMs ?? 10 * 60_000;
  const argv = [
    "-p",
    "--no-session",
    "--approval-mode",
    "yolo",
    "--no-rules",
    "--no-extensions",
    "--no-skills",
    ...(o.model ? ["--model", o.model] : []),
  ];

  return async (skill, basis, outDir) => {
    const run = await exec(argv, rewritePrompt(skill.name, basis), outDir, timeoutMs);
    if (run.exitCode !== 0)
      throw new OmpRewriteError(
        `omp exited with ${run.exitCode}: ${(run.stderr || run.stdout).trim().slice(0, 500)}`,
      );
    const reply = run.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    return { changelog: reply?.slice(0, 500) ?? CHANGELOG_FALLBACK };
  };
}
