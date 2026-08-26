// The claim this project makes about itself, run in front of you.
//
// A drift detector's first duty is to stay quiet when nothing changed, and its second is to fire
// when something did. Either one alone is trivially satisfied: a detector that never reports passes
// the first perfectly, and one that always reports passes the second. This example runs both, on the
// same synthetic provider, and exits non-zero if either claim fails.
//
// It makes no provider call, so it is free and deterministic.

import {
  compare,
  exitCodeFor,
  mulberry32,
  synthCases,
  synthEvalCases,
  synthSnapshot,
} from "@model-regression-sentinel/detect";

const CASES = synthCases(12);
const EVAL = synthEvalCases(CASES);
const FAST = { skipMde: true } as const;
const failures: string[] = [];

const heading = (text: string): void => {
  console.log(`\n${text}\n${"=".repeat(text.length)}`);
};

heading("1. Nothing changed. The detector must not say it did.");
let quietRuns = 0;
for (const seed of [11, 23, 37, 51, 67]) {
  const baseline = synthSnapshot(CASES, {
    label: "baseline",
    replicates: 10,
    rng: mulberry32(seed),
  });
  const candidate = synthSnapshot(CASES, {
    label: "candidate",
    replicates: 10,
    rng: mulberry32(seed + 7919),
  });
  const r = compare(EVAL, baseline, candidate, FAST);
  const quiet = r.verdict !== "SUSPECTED_DRIFT" && r.verdict !== "CONFIRMED_DRIFT";
  if (quiet) quietRuns += 1;
  else failures.push(`seed ${seed} reported ${r.verdict} on an A/A pair`);
  console.log(`  ${quiet ? "ok  " : "FAIL"} seed ${seed}: ${r.verdict}, exit ${exitCodeFor(r)}`);
}
console.log(`  ${quietRuns}/5 A/A comparisons stayed quiet`);

heading("2. Something did change. The detector must say so.");
const dropped = CASES.map((c) => ({ ...c, passRate: Math.max(0, c.passRate - 0.3) }));
const baseline = synthSnapshot(CASES, { label: "baseline", replicates: 10, rng: mulberry32(11) });
const degraded = synthSnapshot(dropped, {
  label: "candidate",
  replicates: 10,
  rng: mulberry32(11 + 7919),
});
const single = compare(EVAL, baseline, degraded, FAST);
console.log(`  a single crossing is ${single.verdict}, exit ${exitCodeFor(single)}`);
if (single.verdict !== "SUSPECTED_DRIFT") {
  failures.push(`a real 30 point drop reported ${single.verdict} rather than SUSPECTED_DRIFT`);
}

heading("3. One crossing is not a regression. A reproduction is.");
const confirmation = synthSnapshot(dropped, {
  label: "confirmation",
  replicates: 10,
  rng: mulberry32(31337),
});
const confirmed = compare(EVAL, baseline, degraded, { ...FAST, confirmation });
console.log(
  `  with an independent confirmation arm: ${confirmed.verdict}, exit ${exitCodeFor(confirmed)}`,
);
if (exitCodeFor(single) !== 0) failures.push("a suspected finding failed the build");
if (exitCodeFor(confirmed) !== 1) failures.push("a confirmed finding did not fail the build");

if (failures.length > 0) {
  console.error(`\n${failures.length} claim(s) violated:\n  ${failures.join("\n  ")}`);
  process.exitCode = 1;
} else {
  console.log("\nBoth claims hold: quiet when nothing moved, and loud only when it reproduced.");
}
