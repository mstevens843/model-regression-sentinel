// MUTANT. Models: treating a collection that failed as a collection that found nothing.
//
// THIS ONE IS NOT HYPOTHETICAL. It is the detector this repository actually shipped. `compare` had
// no check that either arm was an observation at all, so an arm in which every call errored
// produced an empty metric map, an empty findings list, and a fall through to the branch that
// reports NO_DRIFT with the sentence "the suite had the power to detect the effect sizes it
// searched for" attached. The gate ledger in the same report marked all four gating metrics NOT
// RUN, so the document contradicted itself and still exited 0.
//
// WHY IT IS THE MOST DANGEROUS FAILURE IN THIS FILE, and worse than `alwaysQuiet`. A detector that
// never fires is useless and obviously so: someone eventually notices it has never said anything.
// This one works perfectly right up until the moment it stops being able to see, and then it
// reports the reassuring answer, at exit 0, forever. A week of silent collection failures reads as
// a week of clean runs, and the dashboard is green throughout - which is precisely when a provider
// is most likely to have changed something, because an outage and a deployment are the same event
// seen from two sides.
//
// It is also the failure this project is organised around, stated in its own README: "I could not
// look" and "it got worse" are opposite claims. So is "I could not look" and "nothing changed".
//
// The injected change is one deletion: the could-not-look guard is stripped from the result.

import { type Detector, referenceDetector } from "../detector.js";

export const outageIsQuiet: Detector = {
  name: "M11 outageIsQuiet",
  compare: (cases, baseline, candidate, options) => {
    const real = referenceDetector.compare(cases, baseline, candidate, options);
    if (real.couldNotLook === null) return real;
    // THE BUG: the arm observed nothing, and that is reported as having observed no change.
    return {
      ...real,
      verdict: "NO_DRIFT",
      couldNotLook: null,
      reason:
        "no gating metric moved beyond the permutation null or this provider's measured noise floor, and the suite had the power to detect the effect sizes it searched for.",
    };
  },
  watchRound: referenceDetector.watchRound,
};
