// MUTANT. Models: the paranoid detector. Everything is a regression.
//
// The mirror of `alwaysQuiet`, and it fails a different half of the suite. It exists because a
// metric built only from sensitivity would rank it first: it catches every real regression, always,
// with perfect recall. It is also unusable, and after the third false build failure it gets
// switched off, at which point its recall is zero.
//
// The pair of them is the argument for why this project reports a false-positive rate and a power
// curve together and never one alone.

import { type Detector, referenceDetector } from "../detector.js";

export const alwaysDrift: Detector = {
  name: "M3 alwaysDrift",
  compare: (cases, baseline, candidate, options) => {
    const real = referenceDetector.compare(cases, baseline, candidate, options);
    // THE BUG: every comparison is a confirmed regression, including one it should have refused.
    return {
      ...real,
      verdict: "CONFIRMED_DRIFT",
      reason: "something is different",
      confirmedMetrics: ["quality"],
      suspectedMetrics: [],
    };
  },
  watchRound: (state, outcomes, config) => {
    const r = referenceDetector.watchRound(state, outcomes, config);
    return { state: { ...r.state, alarmed: true }, alarmed: true };
  },
};
