// What a confirmed drift report actually reads like.
//
// Prints the terminal form of every verdict the detector can reach, so the distinctions between them
// are visible rather than described. The one worth reading closely is INCONCLUSIVE, which is the
// verdict a diff-based tool does not have and the one that keeps "we saw nothing" from being read as
// "we checked".
//
// Makes no provider call.

import {
  compare,
  mulberry32,
  synthCases,
  synthEvalCases,
  synthSnapshot,
} from "@model-regression-sentinel/detect";
import { gatesFor, renderGates, renderText } from "@model-regression-sentinel/report";

const CASES = synthCases(12);
const EVAL = synthEvalCases(CASES);
const baseline = synthSnapshot(CASES, { label: "baseline", replicates: 10, rng: mulberry32(11) });

const dropped = CASES.map((c) => ({ ...c, passRate: Math.max(0, c.passRate - 0.3) }));
const scenarios = [
  {
    title: "nothing changed",
    candidate: synthSnapshot(CASES, { label: "candidate", replicates: 10, rng: mulberry32(7930) }),
    confirmation: undefined,
  },
  {
    title: "a real regression, seen once",
    candidate: synthSnapshot(dropped, {
      label: "candidate",
      replicates: 10,
      rng: mulberry32(7930),
    }),
    confirmation: undefined,
  },
  {
    title: "the same regression, reproduced",
    candidate: synthSnapshot(dropped, {
      label: "candidate",
      replicates: 10,
      rng: mulberry32(7930),
    }),
    confirmation: synthSnapshot(dropped, {
      label: "confirmation",
      replicates: 10,
      rng: mulberry32(31337),
    }),
  },
];

for (const s of scenarios) {
  console.log(`\n\n########## ${s.title.toUpperCase()} ##########\n`);
  const result = compare(EVAL, baseline, s.candidate, {
    ...(s.confirmation === undefined ? {} : { confirmation: s.confirmation }),
  });
  console.log(renderText(result));
  console.log(renderGates(gatesFor(result)));
}
