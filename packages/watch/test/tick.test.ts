// The five things one look is allowed to conclude, each pinned in its own test, because the value
// of a monitor is entirely in the fact that its output means something specific.
//
// WHAT THIS FILE PREVENTS. Every status below has a plausible looking implementation that collapses
// it into a neighbour, and every one of those collapses leaves a green dashboard behind:
//
//   `could_not_look` FOLDED INTO `quiet` IS THE WORST DEFECT THIS PROJECT COULD SHIP. "I looked and
//   nothing changed" and "I could not look" are opposite claims and only one of them is ever true.
//   An outage is also exactly when a provider is most likely to be mid-change, so a watcher that
//   reports nothing-changed through a week of silent failures is a canary that has become
//   decoration. It gets three tests: every call errored, a corpus that was swapped underneath the
//   watch, and the exit code that separates "fix the watcher" from "investigate the provider".
//
//   `alarm_raised` PROMOTED TO A BUILD FAILURE. A crossing of 1/alpha is a valid any-time rejection
//   on ONE collection, and one collection is exactly what noise crosses a threshold on. A gate that
//   fires on noise is a gate somebody deletes, which costs more than the alarm was worth.
//
//   `confirmed_drift` REACHED WITHOUT A SECOND INDEPENDENT ROUND. `alarmed` is sticky by design, so
//   a rule resting on the flag alone would confirm on the next tick containing any data at all.
//   What makes the second round independent evidence is that ITS OWN observations raised the
//   wealth, and the negative control below is a quiet round after an alarm: it must NOT confirm.
//
//   `identity_changed` SUBSTITUTING FOR A BEHAVIORAL FINDING, or hiding one. Identity is
//   orthogonal: a vendor can re-tag identical weights, so it never fails a build, and the note must
//   mention both the behaviour and the identity or a reader comes away believing the identity held.
//
// PURITY IS A CONTRACT HERE FOR THE SAME REASON IT IS IN `packages/detect`. `tick` reads no clock,
// writes no file and calls no provider, which is what makes a drift sequence replayable: this file
// hands it the same round twice and requires the same answer, byte for byte.
//
// Every round is drawn from a seeded generator and every `now` is written out. There is no
// `Math.random` and no real clock anywhere below.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  mulberry32,
  synthCases,
  synthEvalCases,
  synthSnapshot,
} from "@model-regression-sentinel/detect";
import type { RunSnapshot } from "@model-regression-sentinel/run";
import { describe, expect, it } from "vitest";
import { initWatchFile } from "../src/state.js";
import { tick, tickExitCode } from "../src/tick.js";

/** Four near-deterministic cases, which is the shape of the real canary split. */
const CASES = synthCases(4, [1, 1, 1, 1]);
const EVAL_CASES = synthEvalCases(CASES);
/** The same cases with the model failing every draw. The adverse round. */
const FAILING = CASES.map((c) => ({ ...c, passRate: 0 }));

const START = new Date("2026-08-26T00:00:00.000Z");
const at = (day: number): Date => new Date(Date.UTC(2026, 7, 26 + day));

const BASELINE = synthSnapshot(CASES, { label: "baseline", replicates: 10, rng: mulberry32(1) });
const WATCH = initWatchFile({ snapshot: BASELINE, cases: EVAL_CASES, now: START });

const quietRound = (seed: number): RunSnapshot =>
  synthSnapshot(CASES, { label: "tick", replicates: 3, rng: mulberry32(seed) });

/**
 * An adverse round large enough to cross 1/alpha on its own.
 *
 * Fifteen failing draws per case. The size is chosen so the alarm lands on a KNOWN tick rather than
 * eventually: the wealth needed is log(1/0.05) and each failure adds a fixed amount, so a round
 * that is too small would make the alarm tests depend on how many ticks the loop happened to run.
 */
const adverseRound = (seed: number): RunSnapshot =>
  synthSnapshot(FAILING, { label: "tick", replicates: 15, rng: mulberry32(seed) });

/** The same round, with every call marked as having failed to reach the provider. */
const unreachable = (snapshot: RunSnapshot): RunSnapshot => ({
  ...snapshot,
  records: snapshot.records.map((r) => ({
    ...r,
    response: { ...r.response, error: "SKIPPED: ANTHROPIC_API_KEY is not set" },
  })),
  errorCount: snapshot.records.length,
});

describe("a watcher that could not look never reports that nothing changed", () => {
  it("calls a round in which every call errored could_not_look, not quiet", () => {
    // THE test in this file. A provider outage is exactly when a provider is most likely to be
    // mid-change, and this is the only thing standing between that and a green dashboard.
    const result = tick({
      file: WATCH,
      cases: EVAL_CASES,
      snapshot: unreachable(quietRound(9)),
      now: at(1),
    });
    expect(result.status).toBe("could_not_look");
    expect(result.status).not.toBe("quiet");
    expect(result.note).toContain("this tick saw nothing at all, and those are opposite claims");
  });

  it("exits 2 on it, because fix the watcher and investigate the provider are opposite instructions", () => {
    const result = tick({
      file: WATCH,
      cases: EVAL_CASES,
      snapshot: unreachable(quietRound(9)),
      now: at(1),
    });
    expect(tickExitCode(result)).toBe(2);
  });

  it("leaves the accumulated wealth exactly where it was, rather than nudging it with zeros", () => {
    // The wealth is the watch. Folding a round of network errors into it would drive an alarm on an
    // infrastructure problem and label it drift.
    const result = tick({
      file: WATCH,
      cases: EVAL_CASES,
      snapshot: unreachable(quietRound(9)),
      now: at(1),
    });
    expect(result.file.cases).toEqual(WATCH.cases);
    expect(result.identityChanges).toEqual([]);
    // The tick is still COUNTED, because a watch that hid its failed looks would look healthy.
    expect(result.file.ticks).toBe(WATCH.ticks + 1);
    expect(result.file.lastTickAt).toBe(at(1).toISOString());
  });

  it("calls a round collected against a different corpus could_not_look, not a finding", () => {
    // The accumulated wealth is a bet about ONE stream. Feeding it observations from another does
    // not produce a weaker result, it produces a meaningless one.
    const elsewhere = synthSnapshot(CASES, {
      label: "tick",
      replicates: 3,
      rng: mulberry32(9),
      corpusDigest: "a-different-rendered-corpus",
    });
    const result = tick({ file: WATCH, cases: EVAL_CASES, snapshot: elsewhere, now: at(1) });
    expect(result.status).toBe("could_not_look");
    expect(tickExitCode(result)).toBe(2);
    expect(result.note).toContain("a look at a different question");
  });

  it("calls a round that requested another alias could_not_look, and says which", () => {
    const otherAlias = synthSnapshot(CASES, {
      label: "tick",
      replicates: 3,
      rng: mulberry32(9),
      requestedModel: "some-other-alias",
    });
    const result = tick({ file: WATCH, cases: EVAL_CASES, snapshot: otherAlias, now: at(1) });
    expect(result.status).toBe("could_not_look");
    expect(result.note).toContain('this round requested "some-other-alias"');
  });

  it("names the first error, because could not look is not actionable and the reason is", () => {
    const result = tick({
      file: WATCH,
      cases: EVAL_CASES,
      snapshot: unreachable(quietRound(9)),
      now: at(1),
    });
    expect(result.note).toContain("ANTHROPIC_API_KEY is not set");
  });
});

describe("quiet data stays quiet, however long the watch runs", () => {
  it("holds quiet and exit 0 across many ticks of ordinary passing rounds", () => {
    // The other half of the anti-vacuity argument. A watcher that never alarms is trivially honest
    // about false positives, so this test is only worth having beside the alarm tests below.
    let file = WATCH;
    for (let i = 0; i < 25; i += 1) {
      const result = tick({
        file,
        cases: EVAL_CASES,
        snapshot: quietRound(100 + i),
        now: at(i + 1),
      });
      expect(result.status, `tick ${i + 1}`).toBe("quiet");
      expect(tickExitCode(result), `tick ${i + 1}`).toBe(0);
      expect(result.alarmedCases, `tick ${i + 1}`).toEqual([]);
      file = result.file;
    }
    expect(file.ticks).toBe(25);
    expect(file.confirmations).toEqual([]);
  });

  it("counts what it folded, so a quiet note is a statement about evidence and not a mood", () => {
    const result = tick({ file: WATCH, cases: EVAL_CASES, snapshot: quietRound(100), now: at(1) });
    expect(result.note).toContain("Folded 12 observation(s) across 4 case(s).");
    expect(result.note).toContain("No case is alarmed and no identity moved.");
  });
});

describe("an alarm is worth a person's attention and is not a build failure", () => {
  const raised = tick({ file: WATCH, cases: EVAL_CASES, snapshot: adverseRound(200), now: at(1) });

  it("raises alarm_raised on the first adverse round", () => {
    expect(raised.status).toBe("alarm_raised");
    expect(raised.alarmedCases.length).toBeGreaterThan(0);
  });

  it("exits 0, because one collection is exactly what noise crosses a threshold on", () => {
    // A gate that fires on noise is a gate somebody deletes, and then there is no gate.
    expect(tickExitCode(raised)).toBe(0);
    expect(raised.status).not.toBe("confirmed_drift");
  });

  it("says in the note that it is not yet a confirmed regression", () => {
    expect(raised.note).toContain("valid any-time rejection");
    expect(raised.note).toContain("not yet a confirmed regression");
  });

  it("records the crossing as an unconfirmed event, which is what makes a later tick able to confirm", () => {
    expect(raised.file.confirmations.every((c) => c.confirmed === false)).toBe(true);
    expect(raised.file.confirmations.length).toBe(raised.alarmedCases.length);
    expect(raised.file.confirmations[0]?.at).toBe(at(1).toISOString());
  });
});

describe("confirmation is a second, independently collected round agreeing", () => {
  const raised = tick({ file: WATCH, cases: EVAL_CASES, snapshot: adverseRound(200), now: at(1) });

  it("reaches confirmed_drift only on the second adverse tick, and exits 1", () => {
    const confirmed = tick({
      file: raised.file,
      cases: EVAL_CASES,
      snapshot: adverseRound(201),
      now: at(2),
    });
    expect(confirmed.status).toBe("confirmed_drift");
    expect(tickExitCode(confirmed)).toBe(1);
    expect(confirmed.note).toContain("Two separate collections now agree");
    expect(confirmed.file.confirmations.some((c) => c.confirmed)).toBe(true);
  });

  it("does NOT confirm on a quiet round after an alarm, however sticky the flag is", () => {
    // The negative control, and the reason `roundWasAdverse` exists. `alarmed` is sticky by design,
    // so a confirmation rule resting on the flag alone would confirm on the next tick that
    // contained any data at all, which would make the confirmation arm worthless.
    const after = tick({
      file: raised.file,
      cases: EVAL_CASES,
      snapshot: quietRound(300),
      now: at(2),
    });
    expect(after.status).toBe("alarm_raised");
    expect(tickExitCode(after)).toBe(0);
    expect(after.file.confirmations.some((c) => c.confirmed)).toBe(false);
    expect(after.note).toContain("this round's own evidence did not agree with it");
  });
});

describe("identity is orthogonal to behaviour and the note carries both", () => {
  const retagged = synthSnapshot(CASES, {
    label: "tick",
    replicates: 3,
    rng: mulberry32(9),
    resolvedModel: "synthetic-model-2",
  });
  const result = tick({ file: WATCH, cases: EVAL_CASES, snapshot: retagged, now: at(1) });

  it("reports identity_changed when the behaviour this suite can measure is quiet", () => {
    expect(result.status).toBe("identity_changed");
    expect(result.identityChanges).toEqual([
      { field: "sha256", before: "fp-synthetic-model-1", after: "fp-synthetic-model-2" },
    ]);
  });

  it("exits 0, because a vendor can re-tag the same weights", () => {
    expect(tickExitCode(result)).toBe(0);
  });

  it("mentions BOTH findings in the note, so no reader comes away believing the identity held", () => {
    expect(result.note).toContain("the behaviour this suite can measure is quiet");
    expect(result.note).toContain(
      "the provider reported a different identity for the same pinned alias",
    );
    expect(result.note).toContain("sha256 went from fp-synthetic-model-1 to fp-synthetic-model-2");
    expect(result.note).toContain("it never substitutes for one");
  });

  it("adopts the new identity, so the alert fires once rather than on every tick forever", () => {
    // A watcher that re-alerted forever is a watcher whose alerts get filtered, at which point the
    // one that mattered is filtered with them. The permanent record is `identityAlerts`.
    expect(result.file.fingerprintSha256).toBe("fp-synthetic-model-2");
    expect(result.file.identityAlerts.length).toBe(1);
    const again = tick({ file: result.file, cases: EVAL_CASES, snapshot: retagged, now: at(2) });
    expect(again.status).toBe("quiet");
    expect(again.identityChanges).toEqual([]);
    expect(again.file.identityAlerts.length).toBe(1);
  });

  it("does not let a quiet identity note suppress a behavioral finding", () => {
    // Identity is appended to every note that has a change in it, whatever the status. The status
    // stays behavioral, because behaviour outranks it.
    const badAndRetagged = synthSnapshot(FAILING, {
      label: "tick",
      replicates: 15,
      rng: mulberry32(210),
      resolvedModel: "synthetic-model-2",
    });
    const both = tick({ file: WATCH, cases: EVAL_CASES, snapshot: badAndRetagged, now: at(1) });
    expect(both.status).toBe("alarm_raised");
    expect(both.identityChanges.length).toBe(1);
    expect(both.note).toContain("crossed 1/alpha on this tick");
    expect(both.note).toContain("Separately, and orthogonally");
  });
});

describe("tick is pure, which is what makes a drift sequence replayable", () => {
  it("returns the identical result when called twice with the identical input", () => {
    const round = quietRound(9);
    const first = tick({ file: WATCH, cases: EVAL_CASES, snapshot: round, now: at(1) });
    const second = tick({ file: WATCH, cases: EVAL_CASES, snapshot: round, now: at(1) });
    expect(second).toEqual(first);
  });

  it("does not mutate the watch file it was handed", () => {
    const before = JSON.stringify(WATCH);
    tick({ file: WATCH, cases: EVAL_CASES, snapshot: adverseRound(200), now: at(1) });
    tick({ file: WATCH, cases: EVAL_CASES, snapshot: quietRound(9), now: at(1) });
    expect(JSON.stringify(WATCH)).toBe(before);
  });

  it("reads no clock: the timestamps it writes are the instant it was handed", () => {
    const result = tick({ file: WATCH, cases: EVAL_CASES, snapshot: quietRound(9), now: at(5) });
    expect(result.file.lastTickAt).toBe("2026-08-31T00:00:00.000Z");
  });

  it("touches no filesystem and reaches no network, by construction rather than by convention", () => {
    // The structural half of the rule, mirroring the purity gate in `packages/detect`. `tick.ts`
    // imports nothing that could read a file or open a socket, so a future edit that reached for
    // one would have to add an import here and would be caught in review by this list.
    const source = readFileSync(fileURLToPath(new URL("../src/tick.ts", import.meta.url)), "utf8");
    // Proof the reader found the file at all, so an empty offender list means clean and not blind.
    expect(source).toContain("export function tick(");
    for (const banned of ["node:fs", "fetch(", "Date.now", "Math.random"]) {
      expect(source.includes(banned), `tick.ts uses ${banned}`).toBe(false);
    }
  });
});
