// MUTANT. Models: a watcher that keeps reporting a healthy wealth while it has quietly gone blind.
//
// The most dangerous mutant in this file, because unlike the others it looks CORRECT on every
// dashboard. Its false alarm rate is exactly right. Its wealth sits near the floor, which reads as
// reassuring. Its verdict is quiet, which is true. And it takes fifty times longer than a fresh
// watch to notice a real regression, because the underlying betting process has spent everything it
// had during a long well-behaved stretch.
//
// It exists because the mixture floor makes this EASIER to miss rather than harder: bounding the
// reported wealth at log(1 - w) is good for a reader and it also hides the deficit that caused the
// problem. The debt has to be tracked separately and surfaced, and this mutant is what stops that
// from being quietly dropped.
//
// The injected change is one line: the underlying martingale is clamped at zero for reporting, so
// the spent sensitivity always reads as none.

import { type Detector, referenceDetector } from "../detector.js";

export const hidesDebt: Detector = {
  name: "M9 hidesDebt",
  compare: referenceDetector.compare,
  watchRound: (state, outcomes, config) => {
    const real = referenceDetector.watchRound(state, outcomes, config);
    // THE BUG: the deficit is erased from the record, so `sensitivityDebt` reads zero forever and
    // the watch never asks to be re-baselined.
    return {
      ...real,
      state: { ...real.state, logMartingale: Math.max(0, real.state.logMartingale) },
    };
  },
};
