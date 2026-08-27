// The boundary: NaN may exist in memory, and may never reach an artifact.
//
// Three primitives return NaN on empty input: `mean([])`, `wilson(0, 0)` and `bootstrapCI([], ...)`.
// That is inherited deliberately from `toolcall-risk-classifier/src/toolcall_risk/eval/metrics.py`,
// where NaN is the sentinel for "no data" and the renderer prints "below the reporting floor". It is
// a reasonable in-memory convention and it is NOT safe to serialize: `canonicalJson` refuses NaN,
// because `JSON.stringify` would silently write `null` and let two different objects hash the same.
//
// That combination has now produced two real defects. `allPassCeiling` was NaN on continuous metrics
// and broke `compare --format json` on every real comparison. `calibratedP` and `noiseFloor95` were
// NaN whenever the baseline was too thin to calibrate, and broke it again on exactly the
// underpowered run a user is most likely to be inspecting. Both were found by machinery, not by
// reading: the first by a test that ran the real binary, the second by an adversarial sweep over
// degenerate corpora.
//
// So the rule is drawn explicitly rather than left to vigilance: **anything that crosses a
// serialization boundary must be finite or null.** This file sweeps the boundary types over the
// degenerate inputs that produced both defects, and it is the guard that makes the third one fail
// here rather than in somebody's pipeline.

import { canonicalJson } from "@model-regression-sentinel/spec";
import { describe, expect, it } from "vitest";
import {
  compare,
  minimumDetectableEffect,
  minimumDetectableRelativeEffect,
  mulberry32,
  synthCases,
  synthEvalCases,
  synthSnapshot,
} from "../src/index.js";

/** Every non-finite number in a value, with the path that reached it. */
const nonFinite = (v: unknown, path: string): readonly string[] => {
  if (typeof v === "number") return Number.isFinite(v) ? [] : [`${path} = ${String(v)}`];
  if (v === null || typeof v !== "object") return [];
  if (Array.isArray(v)) return v.flatMap((x, i) => nonFinite(x, `${path}[${i}]`));
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) =>
    nonFinite(x, `${path}.${k}`),
  );
};

/** The two halves of the guarantee: no non-finite numbers, and it actually serializes. */
const assertSerializable = (label: string, value: unknown): void => {
  expect(nonFinite(value, label), `${label} carries a non-finite number`).toEqual([]);
  expect(() => canonicalJson(value), `${label} did not survive canonical JSON`).not.toThrow();
};

/**
 * The degenerate shapes. Each one produced or would have produced a real defect:
 * an all-perfect corpus has zero observed variance; a knife-edge corpus maximises it; fewer than
 * four replicates makes the A/A calibration impossible, which is what NaN'd `calibratedP`.
 */
const SHAPES: readonly (readonly [string, readonly number[]])[] = [
  ["all-perfect", Array.from({ length: 12 }, () => 1)],
  ["all-failing", Array.from({ length: 12 }, () => 0)],
  ["knife-edge", Array.from({ length: 12 }, () => 0.5)],
  ["single-case", [1]],
  ["mixed", [1, 1, 0.75, 0.9, 1, 0.5, 1, 1, 0.6, 1, 1, 0.85]],
];

describe("a CompareResult is always serializable", () => {
  for (const [name, rates] of SHAPES) {
    for (const replicates of [1, 2, 3, 4, 10]) {
      it(`${name} at ${replicates} replicate(s)`, () => {
        const cases = synthCases(rates.length, rates);
        const evals = synthEvalCases(cases);
        const baseline = synthSnapshot(cases, { label: "b", replicates, rng: mulberry32(1) });
        const candidate = synthSnapshot(cases, { label: "c", replicates, rng: mulberry32(2) });
        // skipMde only below 3, where the simulation has nothing to draw from anyway.
        const result = compare(evals, baseline, candidate, { skipMde: replicates < 3 });
        assertSerializable(`compare(${name},n=${replicates})`, result);
      });
    }
  }

  it("survives a mismatched corpus, which returns a shell result", () => {
    const cases = synthCases(6);
    const evals = synthEvalCases(cases);
    const b = synthSnapshot(cases, { label: "b", replicates: 10, rng: mulberry32(1) });
    const c = synthSnapshot(cases, {
      label: "c",
      replicates: 10,
      rng: mulberry32(2),
      corpusDigest: "different",
    });
    assertSerializable("NOT_COMPARABLE", compare(evals, b, c, { skipMde: true }));
  });
});

describe("an MdeResult is always serializable", () => {
  const cases: readonly (readonly [string, () => unknown])[] = [
    [
      "binary all-perfect",
      () =>
        minimumDetectableEffect([10, 10, 10, 10], 10, {
          simulations: 20,
          permutationDraws: 20,
          seed: 1,
        }),
    ],
    [
      "binary all-zero",
      () =>
        minimumDetectableEffect([0, 0, 0, 0], 10, {
          simulations: 20,
          permutationDraws: 20,
          seed: 1,
        }),
    ],
    [
      "binary empty",
      () => minimumDetectableEffect([], 10, { simulations: 20, permutationDraws: 20, seed: 1 }),
    ],
    [
      "binary one case",
      () => minimumDetectableEffect([7], 10, { simulations: 20, permutationDraws: 20, seed: 1 }),
    ],
    [
      "relative constant",
      () =>
        minimumDetectableRelativeEffect(
          [
            [5, 5, 5, 5],
            [5, 5, 5, 5],
          ],
          { simulations: 20, permutationDraws: 20, seed: 1 },
        ),
    ],
    [
      "relative zeros",
      () =>
        minimumDetectableRelativeEffect([[0, 0, 0, 0]], {
          simulations: 20,
          permutationDraws: 20,
          seed: 1,
        }),
    ],
    [
      "relative empty",
      () => minimumDetectableRelativeEffect([], { simulations: 20, permutationDraws: 20, seed: 1 }),
    ],
    [
      "relative single draw",
      () =>
        minimumDetectableRelativeEffect([[7]], { simulations: 20, permutationDraws: 20, seed: 1 }),
    ],
  ];
  for (const [name, build] of cases) {
    it(name, () => {
      assertSerializable(`mde(${name})`, build());
    });
  }
});

describe("the in-memory sentinel is documented rather than accidental", () => {
  it("mean, wilson and bootstrapCI still return NaN on empty input, by inheritance", async () => {
    // Asserted rather than merely tolerated. These three are ported from the sibling's metrics.py,
    // where NaN means "no data" and the renderer prints "below the reporting floor". If one of them
    // ever starts returning 0 instead, a caller would read an empty sample as a measured zero, which
    // is a worse failure than the serialization hazard this file guards.
    const { mean, wilson, bootstrapCI } = await import("../src/stats.js");
    expect(Number.isNaN(mean([]))).toBe(true);
    expect(Number.isNaN(wilson(0, 0).point)).toBe(true);
    expect(Number.isNaN(bootstrapCI([], mean, mulberry32(1), 10).point)).toBe(true);
  });

  it("and none of them reaches a boundary type, which is the whole rule", () => {
    // The compare and MDE sweeps above are the enforcement. This restates the rule in one place so
    // that a future primitive returning NaN has a stated reason to stay away from an artifact.
    const cases = synthCases(4, [1, 1, 1, 1]);
    const evals = synthEvalCases(cases);
    const b = synthSnapshot(cases, { label: "b", replicates: 2, rng: mulberry32(1) });
    const c = synthSnapshot(cases, { label: "c", replicates: 2, rng: mulberry32(2) });
    const result = compare(evals, b, c, { skipMde: true });
    // The two fields that were NaN before this pass.
    for (const f of result.findings) {
      expect(f.calibratedP === null || Number.isFinite(f.calibratedP)).toBe(true);
      expect(f.noiseFloor95 === null || Number.isFinite(f.noiseFloor95)).toBe(true);
    }
  });
});
