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
// WHAT `blocks:check` DOES NOT CATCH, and it is worth knowing before quoting a count.
// `generated-blocks.mjs --check` compares each BLOCK against the ARTIFACT it reads. It cannot tell
// that the artifact itself has gone stale: `results/tests.json` said 579 while the green suite was
// 599, and the block matched the artifact perfectly, so the check passed. Adding tests without
// re-running this script leaves a number that is wrong and gated green.
//
// The honest rule: THIS SCRIPT IS THE ONLY THING THAT MAY WRITE A TEST COUNT, and it must be re-run
// whenever the suite changes. It refuses to record a count from a run that was not green, so the
// number it writes always means "this many passed".
//
// `--check` IS THE GATE, AND IT IS NOT THE SAME COMMAND AS THE WRITER.
//
// Without it there was a stale-artifact class nothing caught. `generated-blocks.mjs --check`
// compares each BLOCK against the ARTIFACT it reads; it has no way to know the artifact itself has
// gone stale. `results/tests.json` said 579 while the green suite contained 599, the block matched
// the artifact perfectly, and every gate passed. Adding tests without re-running this script left a
// published number that was wrong and gated green.
//
// WHY IT ENUMERATES INSTEAD OF RE-RUNNING. The obvious gate is to run the suite a second time
// inside `audit:release` and compare. That works and costs 34 seconds against a turbo-cached
// `pnpm test` of ~0. `vitest list` COLLECTS without executing: it evaluates every `describe` and
// `it`, including the ones generated in loops over `ALL_SPLITS` and over the corpus, so the count it
// reports is exact. Measured against a full run, package by package: 36/163/77/57/95/115/56, every
// one identical. It takes 5 seconds.
//
// THE TWO GATES MAKE DIFFERENT CLAIMS AND NEITHER SUBSUMES THE OTHER. `pnpm test` says the tests
// PASS. `--check` says the recorded count is what the suite CONTAINS. Enumeration cannot tell you
// anything about passing, which is why this does not replace the test step; and a passing run
// cannot tell you the recorded number is current, which is why the test step did not catch this.
// `--check` additionally requires `passed === tests` in the artifact, so a run with a skipped test
// cannot be recorded as though everything ran.
//
// IT NEVER WRITES IN CHECK MODE. Regenerating to make a check pass is the move that turns a working
// gate into decoration, and it is the same rule `verify-corpus.sh` states about the manifest.
//
// Usage: node scripts/test-counts.mjs [--check]

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
// Directories only. `.DS_Store` in packages/ is enough to make this refuse otherwise, and a
// docs number that cannot be regenerated on a Mac is a docs number that goes stale on a Mac.
const PACKAGES = readdirSync(join(ROOT, "packages"))
  .filter((name) => statSync(join(ROOT, "packages", name)).isDirectory())
  .sort();

const CHECK = process.argv.includes("--check");

// ---- check mode: enumerate, compare, never write -------------------------------------------------

if (CHECK) {
  if (!existsSync(join(ROOT, "results/tests.json"))) {
    console.error("results/tests.json does not exist. Run `pnpm test:count` to produce it.");
    process.exit(1);
  }
  const recorded = JSON.parse(readFileSync(join(ROOT, "results/tests.json"), "utf8"));
  const byPackage = new Map(recorded.packages.map((r) => [r.package, r]));
  const drift = [];

  for (const pkg of PACKAGES) {
    const r = spawnSync(join(ROOT, "node_modules/.bin/vitest"), ["list", "--json"], {
      cwd: join(ROOT, "packages", pkg),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    let listed;
    try {
      listed = JSON.parse(r.stdout);
    } catch {
      drift.push(`${pkg}: could not enumerate its tests (${(r.stderr ?? "").slice(0, 120)})`);
      continue;
    }
    const tests = listed.length;
    const files = new Set(listed.map((t) => t.file)).size;
    const was = byPackage.get(pkg);
    if (was === undefined) {
      drift.push(`${pkg}: has ${tests} test(s) and is absent from results/tests.json`);
      continue;
    }
    if (was.tests !== tests)
      drift.push(`${pkg}: recorded ${was.tests} test(s), the suite has ${tests}`);
    if (was.files !== files)
      drift.push(`${pkg}: recorded ${was.files} file(s), the suite has ${files}`);
    // A count recorded from a run with skipped tests would claim more green than there was.
    if (was.passed !== was.tests) {
      drift.push(
        `${pkg}: recorded ${was.passed} passed of ${was.tests}, so the count is not all-green`,
      );
    }
    byPackage.delete(pkg);
  }
  for (const [name] of byPackage) {
    drift.push(`${name}: is in results/tests.json and no longer exists`);
  }

  const total = recorded.packages.reduce((n, r) => n + r.tests, 0);
  if (recorded.totalTests !== total) {
    drift.push(`totalTests is ${recorded.totalTests} and the per-package rows sum to ${total}`);
  }

  if (drift.length > 0) {
    console.error("results/tests.json no longer describes this suite:");
    for (const d of drift) console.error(`  ${d}`);
    console.error("");
    console.error("Every published test count is generated from that file, so it is wrong in the");
    console.error("README and in RESULTS.md right now. Run `pnpm test:count` to re-record it.");
    console.error("Do NOT hand-edit the number: this script refuses to record one from a run that");
    console.error("was not green, and a hand-edited count loses that guarantee.");
    process.exit(1);
  }
  console.log(
    `results/tests.json is current: ${recorded.totalTests} tests across ${PACKAGES.length} packages`,
  );
  process.exit(0);
}

// ---- write mode: run the suite, record only a green result ---------------------------------------

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
    // `testResults` is one entry per FILE. `numTotalTestSuites` counts describe BLOCKS - 12 of them
    // in a package with 3 test files - and it was being recorded under a field named `files`, so
    // the README's "test files" row published a suite count. Found by `--check`, which enumerates
    // distinct file paths and disagreed on every package while agreeing on every test count.
    files: report.testResults?.length ?? 0,
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
