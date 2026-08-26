// MUTANT. Models: the obvious tool. Diff the two pass rates, and if they differ, call it a regression.
//
// This is not a straw man, it is what almost every homegrown drift check actually does, and it is
// what a reader will reasonably assume this project does until told otherwise. It has no null model
// at all: it cannot distinguish a 4 point difference produced by a genuine provider change from a 4
// point difference produced by twelve cases at ten replicates each rolling slightly differently.
//
// The injected change is a single one: the verdict is taken from the sign of the effect rather than
// from either null. Everything else, including the measurement, is the real detector.

import type { CompareResult } from "../compare.js";
import { type Detector, referenceDetector } from "../detector.js";

export const rawDiff: Detector = {
  name: "M1 rawDiff",
  compare: (cases, baseline, candidate, options) => {
    const real = referenceDetector.compare(cases, baseline, candidate, options);
    if (real.verdict === "NOT_COMPARABLE") return real;
    const quality = real.findings.find((f) => f.metric === "quality");
    // THE BUG: any observed drop is a confirmed regression.
    const moved = quality !== undefined && quality.effect < 0;
    const out: CompareResult = {
      ...real,
      verdict: moved ? "CONFIRMED_DRIFT" : "NO_DRIFT",
      reason: moved
        ? "the pass rate is lower than it was"
        : "the pass rate is not lower than it was",
      confirmedMetrics: moved ? ["quality"] : [],
      suspectedMetrics: [],
    };
    return out;
  },
  watchRound: referenceDetector.watchRound,
};
