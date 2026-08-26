// MUTANT. Models: a drift tool built on one sample per case.
//
// This is the default shape of every eval runner, because for a pre-merge eval one sample per case
// is often enough: the question there is whether a deliberate change broke something, and the
// baseline was collected minutes ago under identical conditions.
//
// For drift it is not enough, and the reason is not a matter of degree. With one draw per case there
// is NOTHING TO ESTIMATE RUN-TO-RUN VARIABILITY FROM. The tool has no information about how much
// this provider moves on its own, so it cannot form the comparison it is claiming to make, at any
// sample size of cases. Adding more cases does not help, because each still contributes one draw.
//
// The injected change is that the replicate guard is removed and a verdict is produced anyway.

import { type Detector, referenceDetector } from "../detector.js";

export const singleReplicateOk: Detector = {
  name: "M8 singleReplicateOk",
  compare: (cases, baseline, candidate, options) => {
    const real = referenceDetector.compare(cases, baseline, candidate, options);
    // THE BUG: an INCONCLUSIVE caused by too few replicates is overwritten with a confident verdict.
    if (real.verdict !== "INCONCLUSIVE") return real;
    return { ...real, verdict: "NO_DRIFT", reason: "no difference observed" };
  },
  watchRound: referenceDetector.watchRound,
};
