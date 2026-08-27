// The mutant discrimination matrix, measured by running it.
//
// WHAT THIS PRODUCES AND WHY IT IS A SEPARATE ARTIFACT. `RESULTS.md` carried a hand-maintained
// table of which calibration scenarios each detector mutant fails. It was correct when written and
// wrong by the next release: it said "9 of 9" against 11 mutants, omitted `metadataIsRegression`
// entirely, and did not record that `alwaysDrift` had begun failing scenario 12. That is the exact
// shape of claim `ci.yml` warns about - a number maintained by hand goes wrong silently - in the
// document whose entire purpose is to be the verification record.
//
// It cannot be derived by reading the source. `mutants/index.ts` declares a `mustFail` list, but
// that list is a FLOOR rather than an exact set, by design: these mistakes are not surgically
// isolated from one another, so a mutant routinely fails scenarios it does not name. The only way
// to know what actually fails is to run every mutant against every scenario.
//
// COSTS NOTHING AND CALLS NOTHING. Every scenario is seeded synthetic data, so this is deterministic
// and makes no provider call. It is a separate script rather than a generator inside
// `generated-blocks.mjs` because that script deliberately imports nothing from `dist/` - a docs
// generator that needs a build cannot run on a fresh clone or in a pre-commit hook. This writes an
// artifact; the block reads it. Same shape as `calibrate.mjs` and `results/calibration.json`.
//
// Usage: node scripts/discrimination.mjs

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

let detect;
try {
  detect = await import(join(ROOT, "packages/detect/dist/index.js"));
} catch (cause) {
  console.error("this script reads the built packages. Run `pnpm build` first.");
  console.error(String(cause));
  process.exit(2);
}

const { ALL_MUTANTS, ALL_SCENARIOS, referenceDetector, runCalibration } = detect;

const reference = runCalibration(referenceDetector);
const mutants = ALL_MUTANTS.map((mutant) => {
  const report = runCalibration(mutant.detector);
  const failed = report.scenarios.filter((s) => !s.passed).map((s) => s.id);
  return {
    id: mutant.id,
    description: mutant.description,
    mustFail: [...mutant.mustFail],
    actuallyFailed: failed,
    // An escape is a scenario the mutant DECLARES it must fail and does not. That is the number
    // that makes the calibration suite a statement about the detector rather than about itself.
    escapes: mutant.mustFail.filter((id) => !failed.includes(id)),
  };
});

const payload = {
  schemaVersion: 1,
  scenarios: ALL_SCENARIOS.map((s) => ({ id: s.id, title: s.title })),
  reference: {
    passed: reference.summary.passed,
    total: reference.summary.total,
    clean: reference.passed,
  },
  mutants,
  totalEscapes: mutants.reduce((n, m) => n + m.escapes.length, 0),
};

writeFileSync(join(ROOT, "results/discrimination.json"), `${JSON.stringify(payload, null, 2)}\n`);

console.log(`scenarios ${payload.scenarios.length}, mutants ${mutants.length}`);
console.log(`reference detector: ${reference.summary.passed}/${reference.summary.total}`);
console.log(`escapes: ${payload.totalEscapes}`);
console.log("written to results/discrimination.json");

// A SUITE WITH AN ESCAPE IS A SUITE THAT DOES NOT DISCRIMINATE, and writing the artifact anyway
// would let a stale-but-present file paper over it. The test suite asserts the same property; this
// is here so that regenerating the docs cannot be the step that hides a real regression.
if (payload.totalEscapes > 0) {
  console.error("");
  console.error("ESCAPES: a mutant did not fail a scenario it declares it must fail.");
  console.error("The calibration suite no longer discriminates against that mistake.");
  process.exitCode = 1;
}
