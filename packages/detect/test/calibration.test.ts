// The detector's own error behaviour, asserted rather than described.
//
// `docs/DETECTOR_CARD.md` states the method, the nulls, the assumptions and the limits.
// `results/CALIBRATION.md` carries the measured numbers. This file is the part that fails a build
// when either of them stops being true, and it exists because a statistical claim in a document is
// a claim, while a statistical claim in a test is a property.
//
// The NaN assertions look like housekeeping and are not. NaN in an `MdeResult` broke `--format json`
// on every real comparison in v0.1, because `canonicalJson` refuses NaN by design: `JSON.stringify`
// would silently write `null` and let two different objects hash the same. Two correct decisions met
// and produced a broken command, and nothing but running the real binary against real data found it.

import { canonicalJson } from "@model-regression-sentinel/spec";
import { describe, expect, it } from "vitest";
import {
  benjaminiHochberg,
  compare,
  exitCodeFor,
  minimumDetectableEffect,
  minimumDetectableRelativeEffect,
  mulberry32,
  ruleOfThree,
  simulatePower,
  smoothedRate,
  synthCases,
  synthEvalCases,
  synthSnapshot,
} from "../src/index.js";

const CASES = synthCases(12);
const EVAL = synthEvalCases(CASES);

const pair = (drop: number, replicates: number, seed = 11) => {
  const dropped = CASES.map((c) => ({ ...c, passRate: Math.max(0, c.passRate - drop) }));
  return {
    baseline: synthSnapshot(CASES, { label: "baseline", replicates, rng: mulberry32(seed) }),
    candidate: synthSnapshot(dropped, {
      label: "candidate",
      replicates,
      rng: mulberry32(seed + 7919),
    }),
    confirmation: synthSnapshot(dropped, {
      label: "confirmation",
      replicates,
      rng: mulberry32(seed + 31337),
    }),
  };
};

describe("a small sample cannot confirm a realistic drift", () => {
  it("refuses to confirm a ten point drop at three replicates", () => {
    // Ten points is a regression anyone would want to hear about. At three replicates per arm the
    // suite cannot resolve it, and the honest answer is that the question was not settled. A tool
    // that confirmed here would be claiming a resolution the sample does not have.
    const { baseline, candidate, confirmation } = pair(0.1, 3);
    const r = compare(EVAL, baseline, candidate, { skipMde: true, confirmation });
    expect(r.verdict).not.toBe("CONFIRMED_DRIFT");
    expect(exitCodeFor(r)).toBe(0);
  });

  it("refuses even a verdict when there is only one replicate, because noise cannot be estimated", () => {
    const { baseline, candidate } = pair(0.3, 1);
    expect(compare(EVAL, baseline, candidate, { skipMde: true }).verdict).toBe("INCONCLUSIVE");
  });

  it("and does confirm the same drop once the sample can carry it", () => {
    // The paired "must" beside the "must not". Without this, every assertion above is satisfied by a
    // detector that has been switched off.
    const { baseline, candidate, confirmation } = pair(0.3, 10);
    const r = compare(EVAL, baseline, candidate, { skipMde: true, confirmation });
    expect(r.verdict).toBe("CONFIRMED_DRIFT");
    expect(exitCodeFor(r)).toBe(1);
  });
});

describe("multiple comparisons move the threshold", () => {
  it("stops being significant when null tests are added beside it", () => {
    // The whole content of a multiplicity correction, in one assertion. A p-value of 0.02 clears
    // Benjamini-Hochberg at q=0.10 on its own and does not clear it once it is the smallest of
    // twenty, because the expected proportion of false discoveries among what gets flagged is what
    // is being controlled, and twenty chances to be unlucky is a different question from one.
    const alone = benjaminiHochberg([0.02], 0.1);
    expect(alone.rejected[0]).toBe(true);

    const crowded = benjaminiHochberg([0.02, ...Array.from({ length: 19 }, () => 0.9)], 0.1);
    expect(crowded.rejected[0], "0.02 should not survive as the smallest of twenty at q=0.10").toBe(
      false,
    );
  });

  it("keeps a genuinely small p-value even in a crowd", () => {
    // The paired "must". A correction that rejected everything under multiplicity would pass the
    // test above and be useless.
    const crowded = benjaminiHochberg([0.0001, ...Array.from({ length: 19 }, () => 0.9)], 0.1);
    expect(crowded.rejected[0]).toBe(true);
  });

  it("scales the bar with the number of tests, monotonically", () => {
    const p = 0.006;
    const at = (m: number) =>
      benjaminiHochberg([p, ...Array.from({ length: m - 1 }, () => 0.9)], 0.1).rejected[0];
    expect(at(1)).toBe(true);
    expect(at(10)).toBe(true);
    // Somewhere above this the same p-value stops clearing the bar, and it never un-stops.
    expect(at(100)).toBe(false);
    expect(at(500)).toBe(false);
  });
});

describe("no statistic in an MdeResult is ever NaN", () => {
  const binary = minimumDetectableEffect([10, 10, 9, 8, 10, 7, 10, 10], 10, {
    simulations: 40,
    permutationDraws: 40,
    seed: 1,
  });
  const continuous = minimumDetectableRelativeEffect(
    [
      [70, 72, 68, 74],
      [1100, 1180, 1050, 1220],
    ],
    { simulations: 30, permutationDraws: 30, seed: 1 },
  );

  it("reports a finite ceiling for a binary metric", () => {
    expect(binary.allPassCeiling).not.toBeNull();
    expect(Number.isFinite(binary.allPassCeiling as number)).toBe(true);
  });

  it("reports NULL, not NaN, for a continuous metric that has no all-passed to bound", () => {
    // This exact field was NaN in v0.1 and it broke `sentinel compare --format json` on every
    // comparison of two real runs.
    expect(continuous.allPassCeiling).toBeNull();
    expect(Number.isNaN(continuous.allPassCeiling as unknown as number)).toBe(false);
  });

  it("survives canonical JSON, which is the thing that actually broke", () => {
    // The regression test with teeth: canonicalJson throws on NaN, so this passing IS the guarantee.
    expect(() => canonicalJson(binary)).not.toThrow();
    expect(() => canonicalJson(continuous)).not.toThrow();
  });

  it("has no NaN anywhere in either result, under a full walk", () => {
    const walk = (v: unknown, path: string): readonly string[] => {
      if (typeof v === "number") return Number.isNaN(v) ? [path] : [];
      if (v === null || typeof v !== "object") return [];
      return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) =>
        walk(x, `${path}.${k}`),
      );
    };
    expect(walk(binary, "binary")).toEqual([]);
    expect(walk(continuous, "continuous")).toEqual([]);
  });
});

describe("canonical JSON stays strict, which is what keeps the reports serializable", () => {
  it("refuses NaN and both infinities rather than coercing them to null", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => canonicalJson({ a: Number.NEGATIVE_INFINITY })).toThrow();
  });

  it("refuses an undefined property, which JSON.stringify drops silently", () => {
    expect(JSON.stringify({ a: 1, b: undefined })).toBe(JSON.stringify({ a: 1 }));
    expect(() => canonicalJson({ a: 1, b: undefined })).toThrow();
  });

  it("serializes a whole CompareResult, which is the thing that has to work", () => {
    const { baseline, candidate } = pair(0.3, 10);
    const r = compare(EVAL, baseline, candidate, { skipMde: false });
    expect(() => canonicalJson(r)).not.toThrow();
  });
});

describe("the rule of three is reported and not implied", () => {
  it("matches 3/n and is bounded at one", () => {
    expect(ruleOfThree(10)).toBeCloseTo(0.3, 10);
    expect(ruleOfThree(100)).toBeCloseTo(0.03, 10);
    // Below three replicates the bound is vacuous, and saying "up to 100 percent" is the honest
    // rendering of a sample that establishes nothing.
    expect(ruleOfThree(2)).toBe(1);
    expect(ruleOfThree(0)).toBe(1);
  });
});

// THE SECOND THING BLOCKING NO_DRIFT, which the documentation did not know about.
//
// Every doc in this repository blamed `schemaValid` for `NO_DRIFT` being unreachable: it sits on
// two cases, the sign-flip floor at k=2 is 0.5, and no effect can resolve. That was true and it was
// half the reason. `refusal` blocked it too, on EVERY corpus, for a reason a larger corpus would
// never have fixed.
describe("a metric's minimum detectable effect is searched in the direction that means drift", () => {
  const healthy = Array(12).fill(0); // nobody refuses, which is what a healthy corpus looks like
  const rates = healthy.map((s) => smoothedRate(s, 10));

  it("searching a DROP in refusal never resolves, at any effect size", () => {
    // Not a sensitivity problem: the rate is already 0, so there is nothing to subtract. The
    // simulated power comes back flat and never reaches the target, so the MDE is null at every
    // size on the grid - and a gating metric with no resolvable MDE makes NO_DRIFT unreachable.
    const powers = [0.05, 0.2, 0.6].map((e) =>
      simulatePower(rates, 10, e, { simulations: 120, direction: "drop" }),
    );
    expect(Math.max(...powers), `flat at ${powers.join(", ")}`).toBeLessThan(0.8);
    // Flat, not merely low: more effect buys nothing at all.
    expect(Math.abs((powers[2] as number) - (powers[0] as number))).toBeLessThan(0.05);
  });

  it("searching a RISE resolves, because that is the direction a refusal metric degrades in", () => {
    const small = simulatePower(rates, 10, 0.05, { simulations: 120, direction: "rise" });
    const large = simulatePower(rates, 10, 0.4, { simulations: 120, direction: "rise" });
    expect(large).toBeGreaterThan(0.9);
    expect(large).toBeGreaterThan(small);
  });

  it("and NO_DRIFT is reachable once the direction is right", () => {
    // The verdict this project describes as the one people most want to see, and which no test in
    // the repository had ever produced.
    const flat = synthCases(12, Array(12).fill(0.9));
    const b = synthSnapshot(flat, { label: "baseline", replicates: 10, rng: mulberry32(5) });
    const c = synthSnapshot(flat, { label: "candidate", replicates: 10, rng: mulberry32(6) });
    const r = compare(synthEvalCases(flat), b, c, {});
    expect(r.verdict).toBe("NO_DRIFT");
    expect(exitCodeFor(r)).toBe(0);
    // And it means what it says: every gating metric resolved an MDE.
    for (const f of r.findings.filter((x) => x.gating)) {
      expect(f.mde?.mde, `${f.metric} has no resolvable MDE`).not.toBeNull();
    }
  });
});
