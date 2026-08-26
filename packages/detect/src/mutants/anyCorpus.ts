// MUTANT. Models: comparing whatever two runs it is handed.
//
// The failure is quiet, which is what makes it worth a control. Two runs of different corpora, or
// of the same corpus after a prompt template was edited, will produce a difference, and the
// difference is a difference of EXPERIMENT rather than of provider. Nothing about the resulting
// report looks wrong. The case ids match, the metrics are populated, the p-value is small.
//
// This is also the specific way a drift tool gets its most embarrassing false positive: somebody
// tweaks a prompt, the numbers move, and the tool announces that the provider changed.
//
// The injected change is one comparison: the corpus digest is not checked.

import { type Detector, referenceDetector } from "../detector.js";

export const anyCorpus: Detector = {
  name: "M7 anyCorpus",
  compare: (cases, baseline, candidate, options) =>
    // THE BUG: the digests are forced to agree, so the guard can never fire.
    referenceDetector.compare(
      cases,
      baseline,
      { ...candidate, corpusDigest: baseline.corpusDigest },
      options,
    ),
  watchRound: referenceDetector.watchRound,
};
