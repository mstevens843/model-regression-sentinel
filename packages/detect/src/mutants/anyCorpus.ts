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

import { corpusDigestOf } from "@model-regression-sentinel/run";
import { type Detector, referenceDetector } from "../detector.js";

export const anyCorpus: Detector = {
  name: "M7 anyCorpus",
  compare: (cases, baseline, candidate, options) => {
    // THE BUG: every digest is forced to agree with the case list, so no comparability guard can
    // fire. There are TWO of them now and a mutant that defeats only one is not modelling the
    // mistake - it is being caught by the other guard and looking like a pass.
    //
    // That is exactly what happened when the case-list check was added: this mutant kept forcing
    // only `candidate.corpusDigest` to equal the baseline's, the new check refused the pair for a
    // different reason, the scenario went green, and the mutant ESCAPED the scenario it exists to
    // fail. A negative control that stops being wrong in the way it names has stopped being a
    // control, and the meta-test caught it.
    const digest = corpusDigestOf(cases);
    return referenceDetector.compare(
      cases,
      { ...baseline, corpusDigest: digest },
      { ...candidate, corpusDigest: digest },
      options,
    );
  },
  watchRound: referenceDetector.watchRound,
};
