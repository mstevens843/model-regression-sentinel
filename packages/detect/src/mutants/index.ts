// The negative controls.
//
// A calibration suite that passes everything proves nothing, and you cannot detect that failure by
// running the suite against something correct: a suite with no teeth and a correct detector under
// it produce exactly the same output. The only way to tell them apart is to point the suite at
// detectors that are known to be wrong and require it to say so.
//
// Every mutant here is a PLAUSIBLE wrong detector - each one is a real mistake someone makes, not a
// contrived break - built by wrapping the reference detector and changing exactly one thing. Each
// carries the scenario ids it must fail, and `test/suiteDiscriminates.test.ts` enforces those
// lists, which is what converts "the scenarios passed" from a statement about the scenarios into a
// statement about the detector.
//
// `mustFail` IS A FLOOR, NOT AN EXACT SET. A mutant may fail more scenarios than it names, because
// these mistakes are not surgically isolated from one another. What the list must never do is
// shrink: every id here was observed failing for the reason the mutant models.

import type { Detector } from "../detector.js";
import { alwaysDrift } from "./alwaysDrift.js";
import { alwaysQuiet } from "./alwaysQuiet.js";
import { anyCorpus } from "./anyCorpus.js";
import { hidesDebt } from "./hidesDebt.js";
import { meanLatencyGate } from "./meanLatencyGate.js";
import { noConfirmation } from "./noConfirmation.js";
import { peeks } from "./peeks.js";
import { rawDiff } from "./rawDiff.js";
import { singleReplicateOk } from "./singleReplicateOk.js";

export interface DetectorMutant {
  readonly id: string;
  /** The real-world mistake this models, in one line. The file header carries the full argument. */
  readonly description: string;
  /** Scenario ids this detector MUST fail. Enforced by the meta-test. */
  readonly mustFail: readonly string[];
  readonly detector: Detector;
}

export const ALL_MUTANTS: readonly DetectorMutant[] = [
  {
    id: "rawDiff",
    description:
      "compares point estimates with no null model: any non-zero difference is a regression",
    mustFail: ["01", "03", "04"],
    detector: rawDiff,
  },
  {
    id: "alwaysQuiet",
    description: "never reports drift: passes every honesty property vacuously and is useless",
    mustFail: ["02", "06", "09"],
    detector: alwaysQuiet,
  },
  {
    id: "alwaysDrift",
    description: "reports drift on everything, which is the same as reporting nothing",
    mustFail: ["01", "03", "04", "07", "08"],
    detector: alwaysDrift,
  },
  {
    id: "meanLatencyGate",
    description: "gates CI on a difference of mean latency, over a distribution with a fat tail",
    mustFail: ["04"],
    detector: meanLatencyGate,
  },
  {
    id: "peeks",
    description:
      "runs a fixed-alpha test on every watch round, so repeated looks manufacture alarms",
    mustFail: ["05"],
    detector: peeks,
  },
  {
    id: "noConfirmation",
    description: "treats a single threshold crossing as a confirmed regression and fails the build",
    mustFail: ["09"],
    detector: noConfirmation,
  },
  {
    id: "anyCorpus",
    description: "compares any two runs, including runs of different corpora",
    mustFail: ["08"],
    detector: anyCorpus,
  },
  {
    id: "singleReplicateOk",
    description:
      "returns a confident verdict from one draw per case, where no noise estimate exists",
    mustFail: ["07"],
    detector: singleReplicateOk,
  },
  {
    id: "hidesDebt",
    description: "reports a healthy wealth while it has quietly gone blind, so nobody re-baselines",
    mustFail: ["11"],
    detector: hidesDebt,
  },
];

export {
  rawDiff,
  alwaysQuiet,
  alwaysDrift,
  meanLatencyGate,
  peeks,
  noConfirmation,
  anyCorpus,
  singleReplicateOk,
  hidesDebt,
};
