import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { BackendError } from "@heartwood/core";
import { execa } from "execa";

export interface RunOptions {
  signal?: AbortSignal;
  /** Kill the process after this long. */
  timeoutMs?: number;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs `orca <argv>` and returns the raw result. Injected so the gateway is testable without Orca. */
export type OrcaRunner = (argv: readonly string[], opts?: RunOptions) => Promise<RunResult>;

const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

/**
 * Resolve the binary ourselves so we always spawn a real executable directly. Left to itself,
 * Windows spawning falls back to `cmd.exe` for names it cannot find, which would reintroduce a
 * shell. `.cmd`/`.bat` shims are rejected because they cannot be spawned without one.
 */
export function resolveBinary(bin: string, env: NodeJS.ProcessEnv = process.env): string {
  const win = process.platform === "win32";
  if (/\.(cmd|bat)$/i.test(bin)) {
    throw new BackendError(
      `orca binary "${bin}" is a shell shim and cannot be spawned without a shell; use orca.exe or "orca"`,
      "orca_shim_unsupported",
    );
  }
  const names = win && !/\.exe$/i.test(bin) ? [bin, `${bin}.exe`] : [bin];
  const dirs =
    isAbsolute(bin) || /[\\/]/.test(bin) ? [""] : (env.PATH ?? env.Path ?? "").split(delimiter);
  for (const dir of dirs) {
    for (const n of names) {
      const candidate = dir ? join(dir, n) : n;
      if (isFile(candidate)) return candidate;
    }
  }
  throw new BackendError(`orca binary not found: ${bin}`, "orca_not_found");
}

/** Spawns the Orca CLI with an argv array and NO shell. Resolution happens on first use. */
export function execaRunner(bin = "orca", env?: Record<string, string | undefined>): OrcaRunner {
  if (/\.(cmd|bat)$/i.test(bin)) resolveBinary(bin); // fail fast on a shim
  let resolved: string | undefined;
  return async (argv, opts = {}) => {
    resolved ??= resolveBinary(bin);
    const r = await execa(resolved, [...argv], {
      reject: false,
      shell: false,
      stdin: "ignore",
      windowsHide: true,
      cancelSignal: opts.signal,
      timeout: opts.timeoutMs,
      env,
      extendEnv: true,
    });
    if (r.isCanceled) return { exitCode: 130, stdout: "", stderr: "cancelled" };
    if (r.timedOut) throw new BackendError(`orca timed out after ${opts.timeoutMs}ms`, "timeout");
    return {
      exitCode: r.exitCode ?? 1,
      stdout: String(r.stdout ?? ""),
      stderr: String(r.stderr ?? ""),
    };
  };
}
