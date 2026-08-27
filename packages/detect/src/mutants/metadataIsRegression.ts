// MUTANT. Models: treating a provider metadata change as a quality regression.
//
// The most tempting mistake in this whole project, because the reasoning sounds airtight: the
// endpoint moved, the served model is different, the token counts now come from somewhere else, so
// obviously something changed and obviously the build should fail. Every clause of that is true and
// the conclusion does not follow.
//
// A metadata change alters what the numbers MEAN. It is not a measurement of behaviour and it
// carries no p-value: the field either moved or it did not, and no sampling is involved. Failing a
// build on it means failing every time someone switches from the CLI to a hosted API, every time a
// vendor re-tags identical weights, and every time this repository ships a new adapter version. A
// gate that fires on all of those is a gate that gets removed, and when it is removed the genuine
// behavioural findings go with it.
//
// The injected change is one branch: any substantive metadata difference is promoted to a confirmed
// regression. Everything else, including the measurement, is the real detector.

import { substantive } from "@model-regression-sentinel/run";
import { type Detector, referenceDetector } from "../detector.js";

export const metadataIsRegression: Detector = {
  name: "M10 metadataIsRegression",
  compare: (cases, baseline, candidate, options) => {
    const real = referenceDetector.compare(cases, baseline, candidate, options);
    if (real.verdict === "NOT_COMPARABLE") return real;
    // THE BUG: a fact with no p-value is promoted to a finding that fails a build.
    const moved = substantive(real.metadataChanges);
    if (moved.length === 0) return real;
    return {
      ...real,
      verdict: "CONFIRMED_DRIFT",
      reason: `provider metadata changed: ${moved.map((c) => c.field).join(", ")}`,
      confirmedMetrics: ["quality"],
      suspectedMetrics: [],
    };
  },
  watchRound: referenceDetector.watchRound,
};
