import { describe, expect, it } from "vitest";
import {
  describeAnalysis,
  describeEvolution,
  pct,
  plural,
  sparklinePoints,
  timeAgo,
} from "./format";

describe("format", () => {
  it("draws a proficiency series left to right, high values near the top, clamped to 0..1", () => {
    const pts = sparklinePoints([0, 0.5, 1, 7], 100, 20)
      .split(" ")
      .map((p) => p.split(",").map(Number) as [number, number]);
    expect(pts.map(([x]) => x)).toEqual([2, 34, 66, 98]);
    const ys = pts.map(([, y]) => y);
    expect(ys[0]).toBe(18); // 0 at the bottom
    expect(ys[2]).toBe(2); // 1 at the top
    expect(ys[3]).toBe(ys[2]); // out-of-range values are clamped, not drawn off the chart
    expect(ys[1]).toBeGreaterThan(ys[2] as number);
    expect(ys[1]).toBeLessThan(ys[0] as number);
  });

  it("centres a single point and draws nothing for an empty series", () => {
    expect(sparklinePoints([0.5], 100, 20)).toBe("50.0,10.0");
    expect(sparklinePoints([], 100, 20)).toBe("");
  });

  it("pluralises counts", () => {
    expect([0, 1, 2].map((n) => plural(n, "question"))).toEqual([
      "0 questions",
      "1 question",
      "2 questions",
    ]);
  });

  it("formats rates and ages", () => {
    expect(pct(0.756)).toBe("76%");
    expect(pct(null)).toBe("—");
    expect(pct(0)).toBe("0%");
    const now = Date.parse("2026-10-17T12:00:00Z");
    expect(timeAgo("2026-10-17T11:59:30Z", now)).toBe("30s ago");
    expect(timeAgo("2026-10-17T11:00:00Z", now)).toBe("1h ago");
    expect(timeAgo("2026-10-15T12:00:00Z", now)).toBe("2d ago");
    expect(timeAgo("2026-10-17T12:00:05Z", now)).toBe("0s ago"); // clock skew never goes negative
  });
});

describe("describeAnalysis", () => {
  const agent = { id: "omp" };
  it("states the rank, pass count and lift over no skill", () => {
    expect(
      describeAnalysis({
        evidence: {
          trials: 10,
          passes: 9,
          errors: 0,
          passRate: 0.9,
          agent,
          vsBaseline: { delta: 0.4 },
        },
        rank: "unique",
      }),
    ).toBe("rank unique · 9/10 trials passed · +40 pts vs no skill · with the default model");
  });
  it("shows a negative lift with a minus sign, and errors only when there are some", () => {
    expect(
      describeAnalysis({
        evidence: {
          trials: 10,
          passes: 2,
          errors: 1,
          passRate: 0.2,
          agent,
          vsBaseline: { delta: -0.3 },
        },
        rank: null,
      }),
    ).toBe(
      "inconclusive, no rank · 2/10 trials passed · 1 errored · −30 pts vs no skill · with the default model",
    );
  });
});

describe("describeAnalysis with a chosen model", () => {
  it("names the model the skill was measured with, effort included", () => {
    const agent = { id: "omp", model: "anthropic/claude-sonnet-5-5:high" };
    expect(
      describeAnalysis({
        evidence: { trials: 10, passes: 10, errors: 0, passRate: 1, agent },
        rank: "ultimate",
      }),
    ).toBe("rank ultimate · 10/10 trials passed · with anthropic/claude-sonnet-5-5:high");
  });
});
