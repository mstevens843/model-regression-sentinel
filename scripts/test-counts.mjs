// The test count, from the test runner rather than from anybody's memory of it.
//
// WHY A REGEX CANNOT DO THIS, which is the whole reason the number went stale. Counting `it(` and
// `test(` across the test files gives 404. The README said 267 and the real figure is 547, and none
// of the three agree because several suites generate their cases: `freeze.test.ts` wraps `it()` in
// a loop over the splits, `corpusV1Digest.test.ts` loops over `ALL_SPLITS`, and any `it.each`
// multiplies further. A static count is not a worse estimate of the right number, it is a count of
// a different thing.
//
// So the only honest source is the runner. This shells out to vitest per package with the JSON
// reporter and aggregates, writing `results/tests.json` for `generated-blocks.mjs` to read. Same
// shape as `calibrate.mjs` and `results/calibration.json`: the script that needs a build produces
// an artifact, and the docs generator stays runnable on a fresh clone with no build.
//
// Usage: node scripts/test-counts.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
// Directories only. `.DS_Store` in packages/ is enough to make this refuse otherwise, and a
// docs number that cannot be regenerated on a Mac is a docs number that goes stale on a Mac.
const PACKAGES = readdirSync(join(ROOT, "packages"))
  .filter((name) => statSync(join(ROOT, "packages", name)).isDirectory())
  .sort();

const scratch = mkdtempSync(join(tmpdir(), "sentinel-tests-"));
const rows = [];
let failed = false;

for (const pkg of PACKAGES) {
  const out = join(scratch, `${pkg}.json`);
  // The ROOT binary, by absolute path. pnpm does not put vitest in every package's own
  // node_modules/.bin, so a relative path works for some packages and silently not for others.
  const r = spawnSync(
    join(ROOT, "node_modules/.bin/vitest"),
    ["run", "--reporter=json", `--outputFile=${out}`],
    { cwd: join(ROOT, "packages", pkg), encoding: "utf8" },
  );
  let report;
  try {
    report = JSON.parse(readFileSync(out, "utf8"));
  } catch {
    console.error(`  ${pkg}: no JSON report produced`);
    console.error(r.stderr?.slice(0, 400) ?? "");
    failed = true;
    continue;
  }
  // A FAILING SUITE MUST NOT PRODUCE A COUNT. Recording "547 tests" from a run in which some of
  // them failed would put a number in the README that reads as "547 green" and is not.
  if (report.numFailedTests > 0 || report.numFailedTestSuites > 0) {
    console.error(`  ${pkg}: ${report.numFailedTests} failing test(s)`);
    failed = true;
  }
  rows.push({
    package: pkg,
    files: report.numTotalTestSuites ?? 0,
    tests: report.numTotalTests ?? 0,
    passed: report.numPassedTests ?? 0,
  });
  console.log(`  ${pkg.padEnd(10)} ${String(report.numPassedTests).padStart(4)} passed`);
}

rmSync(scratch, { recursive: true, force: true });

if (failed) {
  console.error("");
  console.error("refusing to record a test count from a run that was not green.");
  process.exit(1);
}

const payload = {
  schemaVersion: 1,
  packages: rows.sort((a, b) => b.tests - a.tests),
  totalTests: rows.reduce((n, r) => n + r.tests, 0),
  totalFiles: rows.reduce((n, r) => n + r.files, 0),
};

writeFileSync(join(ROOT, "results/tests.json"), `${JSON.stringify(payload, null, 2)}\n`);
console.log("");
console.log(`${payload.totalTests} tests across ${rows.length} packages`);
console.log("written to results/tests.json");
