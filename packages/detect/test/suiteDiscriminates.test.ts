// THE MOST IMPORTANT TEST IN THIS REPOSITORY.
//
// A calibration suite that passes everything proves nothing. The failure mode of a test suite is not
// that it rejects good implementations, it is that it ACCEPTS BAD ONES, and that is invisible from a
// green run: a suite with no teeth and a correct detector under it produce exactly the same output.
// The only way to tell them apart is to point the suite at things known to be wrong and require it
// to say so.
//
// The discipline is taken from `durable-agent-outbox/packages/conformance/test/suiteDiscriminates.
// test.ts`, and it matters more here than it did there. Every honesty property of a drift detector
// has the form "does not report drift when there is none", and ALL OF THEM ARE SATISFIED BY A
// DETECTOR THAT NEVER REPORTS ANYTHING. A tool that always answers NO_DRIFT has a perfect
// false-positive rate, never fails a build without cause, and would look excellent on any dashboard
// built from those properties alone. `alwaysQuiet` is shipped as a mutant precisely so that cannot
// quietly become true of the real detector.
//
// So this file asserts two things, and the second is the load-bearing one:
//
//   1. The reference detector passes every calibration scenario.
//   2. Every mutant FAILS every scenario id in its own `mustFail` list.
//
// Without (2), (1) is a statement about the reference and not about the suite.

import { describe, expect, it } from "vitest";
import { referenceDetector } from "../src/detector.js";
import { alwaysQuiet } from "../src/mutants/alwaysQuiet.js";
import { ALL_MUTANTS, type DetectorMutant } from "../src/mutants/index.js";
import { formatCalibration, runCalibration } from "../src/run.js";
import { ALL_SCENARIOS } from "../src/scenarios.js";

describe("the calibration suite discriminates", () => {
  it("passes the reference detector on every scenario", () => {
    const report = runCalibration(referenceDetector);
    expect(report.summary.failed, formatCalibration(report)).toBe(0);
    expect(report.summary.total).toBe(ALL_SCENARIOS.length);
  });

  it("ships a mutant naming only scenarios that exist", () => {
    // A `mustFail` entry pointing at a scenario that was renamed would silently assert nothing,
    // which is the exact failure this file exists to catch.
    const known = new Set(ALL_SCENARIOS.map((s) => s.id));
    for (const mutant of ALL_MUTANTS) {
      expect(mutant.mustFail.length, `${mutant.id} names no scenario`).toBeGreaterThan(0);
      for (const id of mutant.mustFail) {
        expect(known.has(id), `${mutant.id} names unknown scenario ${id}`).toBe(true);
      }
    }
  });

  for (const mutant of ALL_MUTANTS) {
    it(`fails ${mutant.id}: ${mutant.description}`, () => {
      const report = runCalibration(mutant.detector);
      const failedIds = new Set(report.scenarios.filter((s) => !s.passed).map((s) => s.id));
      const escaped = mutant.mustFail.filter((id) => !failedIds.has(id));
      const message = `mutant ${mutant.id} passed scenarios it must fail: [${escaped.join(", ")}]`;
      expect(escaped, `${message}\n${formatCalibration(report)}`).toEqual([]);
      expect(report.passed, `mutant ${mutant.id} passed the whole suite`).toBe(false);
    });
  }

  it("catches the vacuously honest detector on detection, not on any honesty property", () => {
    // The argument for the anti-vacuity scenarios, made executable. `alwaysQuiet` never reports
    // drift, so it passes every scenario that asks the detector NOT to do something: it is quiet on
    // A/A pairs, it never overclaims a tiny effect, it never gates on latency, it never
    // manufactures an alarm from repeated looks. Run only those and it looks perfect.
    const honesty = ["01", "03", "04", "05", "07", "08"];
    const quietOnHonesty = runCalibration(alwaysQuiet, honesty);
    expect(
      quietOnHonesty.summary.failed,
      "the honesty scenarios alone would have certified a detector that does nothing",
    ).toBe(0);

    // The scenarios that require a detection are the only ones that see it.
    const detection = runCalibration(alwaysQuiet, ["02", "06", "09"]);
    expect(detection.summary.failed).toBe(3);
  });

  it("does not fail a mutant by crashing instead of checking", () => {
    // A scenario that throws is reported as a failure, which is right, but a mutant whose failures
    // are ALL crashes would mean the suite is catching a broken harness rather than the injected
    // mistake. At least one named scenario per mutant must fail on an ordinary failed check.
    for (const mutant of ALL_MUTANTS) {
      const report = runCalibration(mutant.detector, [...mutant.mustFail]);
      const checkedFailures = report.scenarios.filter(
        (s) => !s.passed && s.error === undefined && s.checks.some((c) => !c.passed),
      );
      expect(
        checkedFailures.length,
        `every failure for ${mutant.id} was a crash, not a check\n${formatCalibration(report)}`,
      ).toBeGreaterThan(0);
    }
  });

  it("keeps the surgical mutants surgical", () => {
    // The number to watch across releases. Adding scenarios is the easy way to make an existing
    // mutant fail more broadly, and a mutant whose blast radius quietly widens means the new
    // scenarios are blunt rather than sharp.
    //
    // `singleReplicateOk` LEFT THIS SET WHEN SCENARIO 13 ARRIVED, and it was checked rather than
    // waved through - which is the whole point of the guard firing. It is not that 13 is blunt: it
    // asserts one thing, that an arm which never reached the provider is not a report that nothing
    // moved. `singleReplicateOk` overwrites any INCONCLUSIVE with NO_DRIFT, and could-not-look is
    // one of the two things INCONCLUSIVE means, so the mutant commits that error too. Two mistakes
    // that read as unrelated turn out to be one deletion. `outageIsQuiet` is the surgical control
    // for 13 and is in the list below.
    for (const id of ["peeks", "noConfirmation", "anyCorpus", "outageIsQuiet"]) {
      const mutant = ALL_MUTANTS.find((m) => m.id === id);
      expect(mutant, `${id} is no longer in the mutant list`).toBeDefined();
      const report = runCalibration((mutant as DetectorMutant).detector);
      const failed = report.scenarios.filter((s) => !s.passed).map((s) => s.id);
      expect(
        failed.length,
        `${id} now fails ${failed.join(", ")} rather than exactly one scenario`,
      ).toBe(1);
    }
  });
});
