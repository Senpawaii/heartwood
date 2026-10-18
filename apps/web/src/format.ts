import type { AnalyzeResponse, EvolveResponse } from "@heartwood/protocol";

export const pct = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : `${Math.round(n * 100)}%`;

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** SVG polyline `points` for values in 0..1 across a w×h box (flat line for one point). */
export function sparklinePoints(values: readonly number[], w: number, h: number, pad = 2): string {
  if (values.length === 0) return "";
  const x = (i: number) =>
    values.length === 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (values.length - 1);
  const y = (v: number) => h - pad - Math.min(1, Math.max(0, v)) * (h - 2 * pad);
  return values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
}

export const species = {
  dwarf: { label: "Dwarf", realm: "roots & trunk", cls: "bg-bark-700 text-bark-50" },
  elf: { label: "Elf", realm: "branches", cls: "bg-leaf-700 text-white" },
  dryad: { label: "Dryad", realm: "canopy", cls: "bg-leaf-500 text-white" },
} as const;

/** "1 question", "2 questions". */
export const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

const points = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x * 100))} pts`;

/** One line for the outcome of benchmarking a skill. */
export function describeAnalysis(r: AnalyzeResponse): string {
  const e = r.evidence;
  const parts = [
    r.rank ? `rank ${r.rank}` : "inconclusive, no rank",
    `${e.passes}/${e.trials} trials passed`,
  ];
  if (e.errors > 0) parts.push(`${e.errors} errored`);
  if (e.vsBaseline) parts.push(`${points(e.vsBaseline.delta)} vs no skill`);
  return parts.join(" · ");
}

/** One line for the outcome of proposing a new version: promoted, or why the current one stays. */
export function describeEvolution(r: EvolveResponse): string {
  const c = r.comparison;
  const ci = c.ci ? `, 95% CI ${points(c.ci.lower)} to ${points(c.ci.upper)}` : "";
  const evidence = `${c.verdict}, ${points(c.delta)}${ci}`;
  return r.promoted
    ? `Promoted ${r.candidate.digest.slice(0, 15)}… (${evidence})`
    : `Kept the current version (${evidence})`;
}
