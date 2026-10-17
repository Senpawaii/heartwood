import { sparklinePoints } from "../format";

/** Tiny proficiency-over-time chart; values are 0..1. The dot marks the latest value. */
export function Sparkline({
  values,
  label,
  w = 120,
  h = 28,
}: {
  values: readonly number[];
  label: string;
  w?: number;
  h?: number;
}) {
  if (values.length === 0) return <span className="text-xs text-bark-500">no uses yet</span>;
  const points = sparklinePoints(values, w, h);
  const [cx, cy] = points.split(" ").at(-1)?.split(",") ?? [];
  return (
    <svg role="img" aria-label={label} width={w} height={h} className="text-leaf-700">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <circle cx={cx} cy={cy} r="2.5" fill="currentColor" />
    </svg>
  );
}
