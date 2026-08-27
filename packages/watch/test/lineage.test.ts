// The rebaseline protocol, and the four ways it can be subverted.
//
// A watch loses sensitivity as it runs quietly, which cannot be patched away: `eprocess.ts` records
// the trade-off and the measurement. The remedy is to start again from a fresh baseline, and THAT
// is what creates the hole these tests defend. If starting again is the fix, then deleting the state
// file looks like the fix too, and it is not: it produces a watch reporting a healthy multiple, no
// alarms and a short history, having learned nothing and forgotten everything. That watch is
// indistinguishable from a genuinely fresh one and is worse than the blind one it replaced, because
// the blind one at least said so.
//
// So: debt must accumulate visibly, a rotation must require a real new artifact, the history must
// survive it, and none of it may ever look like a regression.

import {
  DEFAULT_ECONFIG,
  evidenceMultiple,
  mulberry32,
  observeMany,
  rebaselineAdvice,
  startEProcess,
  synthCases,
  synthEvalCases,
  synthSnapshot,
} from "@model-regression-sentinel/detect";
import { EXIT_CONFIRMED_REGRESSION, EXIT_OK } from "@model-regression-sentinel/spec";
import { describe, expect, it } from "vitest";
import { debtReport, renderDebt } from "../src/debt.js";
import { identityOf, lifetimeTicks, planRotation } from "../src/lineage.js";
import { initWatchFile, lineageOf, rotateWatchFile } from "../src/state.js";
import { tick, tickExitCode } from "../src/tick.js";

const CASES = synthCases(8);
const EVAL = synthEvalCases(CASES);
const AT = new Date("2026-08-26T00:00:00.000Z");

const snap = (label: string, seed: number, capturedAt: string, replicates = 10) =>
  synthSnapshot(CASES, { label, replicates, rng: mulberry32(seed), capturedAt });

const BASE = snap("baseline", 11, "2026-08-01T00:00:00.000Z");

describe("a quiet watch accumulates debt, visibly", () => {
  it("spends sensitivity on a stream that is doing nothing wrong", () => {
    // p0 is a Wilson LOWER bound, so a quiet stream sits above it and the process loses on nearly
    // every observation. Nothing is drifting. The watch is simply getting duller.
    const rng = mulberry32(7);
    let state = startEProcess("c", 19, 20);
    expect(evidenceMultiple(state)).toBeCloseTo(1, 3);
    for (let i = 0; i < 60; i += 1) {
      state = observeMany(
        state,
        Array.from({ length: 5 }, () => rng() < 0.95),
      );
    }
    expect(evidenceMultiple(state)).toBeGreaterThan(2);
    expect(state.alarmed, "spending sensitivity is not an alarm").toBe(false);
  });

  it("grades the spend rather than leaving a raw log figure nobody can read", () => {
    const rng = mulberry32(7);
    let state = startEProcess("c", 19, 20);
    expect(rebaselineAdvice(state).state).toBe("healthy");
    for (let i = 0; i < 200; i += 1) {
      state = observeMany(
        state,
        Array.from({ length: 5 }, () => rng() < 0.95),
      );
    }
    const advice = rebaselineAdvice(state);
    expect(advice.state).toBe("blind");
    expect(advice.needsRebaseline).toBe(true);
    // The action has to name the command, or the report is a diagnosis with no treatment.
    expect(advice.action).toContain("sentinel baseline rotate");
    // And it must say what a rotation would destroy, because the rotation is irreversible.
    expect(advice.inspectFirst.length).toBeGreaterThan(2);
  });

  it("says the drift it can still catch has become harder to catch", () => {
    // The number an operator acts on. A watch at 8x needs eight times the evidence a fresh one
    // would, so a real regression surfaces that much later, and nothing in a quiet tick says so.
    const rng = mulberry32(7);
    let state = startEProcess("c", 19, 20);
    for (let i = 0; i < 120; i += 1) {
      state = observeMany(
        state,
        Array.from({ length: 5 }, () => rng() < 0.95),
      );
    }
    const dull = rebaselineAdvice(state);
    expect(dull.evidenceMultiple).toBeGreaterThan(2);
    expect(renderDebt(debtReport({ ...watchOf(BASE), cases: [state] }))).toContain(
      "the evidence a fresh watch would",
    );
  });
});

const watchOf = (snapshot: ReturnType<typeof snap>) =>
  initWatchFile({ snapshot, cases: EVAL, now: AT });

describe("a rotation requires a real new baseline artifact", () => {
  const file = watchOf(BASE);
  const plan = (candidate: ReturnType<typeof snap>, seedable = 8) =>
    planRotation({
      current: lineageOf(file).baseline,
      lineage: file.lineage,
      states: file.cases,
      candidate,
      seedableCases: seedable,
      reason: "operator",
    });

  it("refuses the baseline it is already watching, which is the central guard", () => {
    const decision = plan(BASE);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.refusals.join(" ")).toContain("IS the one already being watched");
  });

  it("refuses a baseline that does not move forward in time", () => {
    const decision = plan(snap("older", 5, "2026-07-01T00:00:00.000Z"));
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.refusals.join(" ")).toContain("moves forward in time");
  });

  it("refuses a baseline collected against another corpus, which is a new watch and not a rotation", () => {
    const other = synthSnapshot(CASES, {
      label: "other",
      replicates: 10,
      rng: mulberry32(3),
      capturedAt: "2026-09-01T00:00:00.000Z",
      corpusDigest: "a-different-corpus",
    });
    const decision = plan(other);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.refusals.join(" ")).toContain("different question");
  });

  it("refuses a baseline that grades nothing, so a watch cannot bet against an unmeasured rate", () => {
    const decision = plan(snap("empty", 9, "2026-09-01T00:00:00.000Z"), 0);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.refusals.join(" ")).toContain("grades no case");
  });

  it("returns EVERY refusal rather than the first", () => {
    // A caller who fixes one and re-runs into the next learns to distrust the tool.
    const decision = plan(BASE);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.refusals.length).toBeGreaterThan(1);
  });

  it("accepts a genuinely newer baseline, and warns when it is no larger", () => {
    const decision = plan(snap("fresh", 21, "2026-09-01T00:00:00.000Z"));
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    // Legal and still a bad idea, said out loud: a same-size baseline goes blind on the same
    // schedule, so more replicates is the cure and fresher ones are a reprieve.
    expect(decision.plan.warnings.join(" ")).toContain("More replicates is the cure");
  });

  it("does not warn about size when the replacement is genuinely larger", () => {
    const decision = plan(snap("bigger", 21, "2026-09-01T00:00:00.000Z", 30));
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.plan.warnings.join(" ")).not.toContain("More replicates is the cure");
  });
});

describe("a rotation clears the debt and keeps the record", () => {
  it("clears the wealth, because it was accumulated against a different null", () => {
    let file = watchOf(BASE);
    const rng = mulberry32(4);
    for (let i = 0; i < 40; i += 1) {
      file = {
        ...file,
        cases: file.cases.map((c) =>
          observeMany(
            c,
            Array.from({ length: 5 }, () => rng() < 0.95),
          ),
        ),
        ticks: file.ticks + 1,
      };
    }
    const before = debtReport(file);
    expect(before.worst?.evidenceMultiple ?? 0).toBeGreaterThan(2);

    const next = snap("fresh", 21, "2026-09-01T00:00:00.000Z", 30);
    const decision = planRotation({
      current: lineageOf(file).baseline,
      lineage: file.lineage,
      states: file.cases,
      candidate: next,
      seedableCases: 8,
      reason: "spent_sensitivity",
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;

    const rotated = rotateWatchFile(file, decision.plan, {
      snapshot: next,
      cases: EVAL,
      now: new Date("2026-09-01T01:00:00.000Z"),
    });
    const after = debtReport(rotated);
    expect(after.worst?.evidenceMultiple ?? 99).toBeCloseTo(1, 1);
  });

  it("carries the history forward, so a rotated watch cannot look newly born", () => {
    const withHistory = {
      ...watchOf(BASE),
      ticks: 40,
      identityAlerts: [{ at: "x", field: "resolvedModel", before: "a", after: "b" }],
      confirmations: [{ at: "x", caseId: "syn-c-001", confirmed: true }],
    };
    const next = snap("fresh", 21, "2026-09-01T00:00:00.000Z", 30);
    const decision = planRotation({
      current: lineageOf(withHistory).baseline,
      lineage: withHistory.lineage,
      states: withHistory.cases,
      candidate: next,
      seedableCases: 8,
      reason: "operator",
    });
    if (!decision.ok) throw new Error("expected a legal rotation");
    const rotated = rotateWatchFile(withHistory, decision.plan, {
      snapshot: next,
      cases: EVAL,
      now: new Date("2026-09-01T01:00:00.000Z"),
    });

    expect(lineageOf(rotated).generation).toBe(2);
    expect(rotated.identityAlerts).toHaveLength(1);
    expect(rotated.confirmations).toHaveLength(1);
    // THE POINT. Ticks reset for the generation; lifetime does not.
    expect(rotated.ticks).toBe(0);
    expect(lifetimeTicks(rotated.lineage, rotated.ticks)).toBe(40);
    const record = lineageOf(rotated).rotations[0];
    expect(record?.ticksServed).toBe(40);
    expect(record?.reason).toBe("operator");
    expect(record?.from.label).toBe("baseline");
    expect(record?.to.label).toBe("fresh");
  });

  it("keeps the whole chain, so three rotations read as three", () => {
    let file = { ...watchOf(BASE), ticks: 10 };
    let day = 2;
    for (const label of ["r1", "r2", "r3"]) {
      const next = snap(label, day, `2026-09-0${day}T00:00:00.000Z`, 30);
      const decision = planRotation({
        current: lineageOf(file).baseline,
        lineage: file.lineage,
        states: file.cases,
        candidate: next,
        seedableCases: 8,
        reason: "operator",
      });
      if (!decision.ok)
        throw new Error(`rotation ${label} refused: ${decision.refusals.join("; ")}`);
      file = {
        ...rotateWatchFile(file, decision.plan, {
          snapshot: next,
          cases: EVAL,
          now: new Date(`2026-09-0${day}T01:00:00.000Z`),
        }),
        ticks: 10,
      };
      day += 1;
    }
    expect(lineageOf(file).generation).toBe(4);
    expect(lineageOf(file).rotations).toHaveLength(3);
    expect(lifetimeTicks(file.lineage, file.ticks)).toBe(40);
    expect(debtReport(file).rotations).toBe(3);
  });
});

describe("an accidental restart cannot quietly erase the debt", () => {
  it("a fresh init against the same baseline produces a watch with no history at all", () => {
    // This is the failure mode, demonstrated rather than described. `initWatchFile` is pure and will
    // happily build a blank watch; nothing about the RESULT reveals that a dull watch was discarded.
    // The guard therefore cannot live here. It lives in the CLI, which refuses to write over an
    // existing state file and names `baseline rotate` instead, and `packages/cli/test` asserts it.
    const dull = { ...watchOf(BASE), ticks: 500 };
    const reinit = watchOf(BASE);
    expect(lifetimeTicks(dull.lineage, dull.ticks)).toBe(500);
    expect(lifetimeTicks(reinit.lineage, reinit.ticks)).toBe(0);
    expect(lineageOf(reinit).generation).toBe(1);
  });

  it("a file that predates lineage reads as generation 1 rather than defaulting to a lie", () => {
    const { lineage: _dropped, ...legacy } = watchOf(BASE);
    expect(
      lineageOf(legacy as typeof _dropped extends never ? never : Parameters<typeof lineageOf>[0])
        .generation,
    ).toBe(1);
    expect(lineageOf(legacy as Parameters<typeof lineageOf>[0]).rotations).toEqual([]);
  });
});

describe("spending sensitivity is never a regression", () => {
  it("a blind watch still returns a passing exit code on a quiet tick", () => {
    // A dull instrument and a worse provider are different claims. If this ever fails, the two have
    // been given the same alert channel and the channel will be muted.
    const rng = mulberry32(4);
    let file = watchOf(BASE);
    for (let i = 0; i < 200; i += 1) {
      file = {
        ...file,
        cases: file.cases.map((c) =>
          observeMany(
            c,
            Array.from({ length: 5 }, () => rng() < 0.95),
          ),
        ),
      };
    }
    const report = debtReport(file);
    expect(report.needsRebaseline).toBe(true);

    const quiet = synthSnapshot(CASES, {
      label: "tick",
      replicates: 3,
      rng: mulberry32(99),
      capturedAt: "2026-09-01T00:00:00.000Z",
    });
    const result = tick({ file, cases: EVAL, snapshot: quiet, now: AT });
    expect(tickExitCode(result)).toBe(EXIT_OK);
    expect(tickExitCode(result)).not.toBe(EXIT_CONFIRMED_REGRESSION);
  });

  it("the debt report says so in its own words, so nobody has to infer it", () => {
    const rendered = renderDebt(debtReport(watchOf(BASE)));
    expect(rendered).toContain("never sets a regression exit code");
  });
});

describe("identityOf", () => {
  it("carries the four fields a refusal depends on", () => {
    const id = identityOf(BASE);
    expect(id.label).toBe("baseline");
    expect(id.capturedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(id.replicates).toBe(10);
    expect(id.corpusDigest).toBe(BASE.corpusDigest);
  });
});

describe("the config is honest about what it grades", () => {
  it("names a rotation threshold in evidence multiples rather than log units", () => {
    expect(DEFAULT_ECONFIG.rebaselineEvidenceMultiple).toBeGreaterThan(1);
  });
});
