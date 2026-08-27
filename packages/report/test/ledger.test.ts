// The exit-code ledger, and the single property the whole design exists to guarantee:
// THE PRINTED TABLE AND THE EXIT CODE CANNOT DISAGREE.
//
// WHAT THIS FILE PREVENTS. `exitCodeFromGates` and `exitCodeFor` are two independent
// implementations of one decision. The detector derives the code from its verdict; the ledger
// derives it from the rows it is about to print. That redundancy is deliberate - the rows ARE the
// decision, so a reader of the table can audit the exit code - and redundancy without a test is
// just two things that will eventually differ. The day they differ is the day someone stops
// believing the table, and nothing in a green run would show it, because each half is individually
// coherent.
//
// So the load-bearing assertion here is the equality, swept across every result and BOTH gates:
//
//     exitCodeFromGates(gatesFor(r), gate) === exitCodeFor(r, gate)
//
// The `suspected` half is not a formality. It is the branch where the two implementations reason
// about different things: `exitCodeFor` reads a verdict string, `exitCodeFromGates` counts FLAG
// rows in the metric area. A metric that became a FLAG without becoming a SUSPECTED_DRIFT verdict,
// or the reverse, would separate them, and only running both gates would see it.
//
// A CORPUS MISMATCH IS 2 AND NOT 1, and it outranks everything else in the ledger. It means the
// tool was misused rather than that the provider moved, and a runbook that handles those the same
// way will send someone to read a model changelog about a prompt-template edit.
//
// THE STATUS VOCABULARY IS CLOSED. `renderGates` prints one summary row per member of
// `ALL_GATE_STATUSES` with its meaning beside the count, so a status emitted by `gatesFor` and
// missing from that list would be invisible in the summary while still being printed in the table
// above it. That is a counting error a reader cannot detect, so it is asserted here.
//
// NOT RUN IS NOT A PASS. A ledger with no FAIL in it says only that every gate this run MEASURED
// was clean, and the last test in this file pins the exact sentence that says so.

import {
  compare,
  exitCodeFor,
  mulberry32,
  synthCases,
  synthEvalCases,
  synthSnapshot,
} from "@model-regression-sentinel/detect";
import type { CompareResult } from "@model-regression-sentinel/detect";
import { GATING_METRICS } from "@model-regression-sentinel/spec";
import { describe, expect, it } from "vitest";
import {
  ALL_GATE_STATUSES,
  AREA_COMPARABILITY,
  AREA_IDENTITY,
  AREA_METRIC,
  AREA_POWER,
  type GateRow,
  exitCodeFromGates,
  gatesFor,
  renderGates,
} from "../src/ledger.js";

const CASES = synthCases(8, [1, 1, 0.9, 1, 1, 0.75, 1, 1]);
const EVAL_CASES = synthEvalCases(CASES);
const DRIFTED = CASES.map((c) => ({ ...c, passRate: Math.max(0, c.passRate - 0.3) }));

// Seeded generators everywhere. A ledger test that moved between runs would be grading the machine.
const baseline = synthSnapshot(CASES, { label: "baseline", replicates: 10, rng: mulberry32(11) });
const quietArm = synthSnapshot(CASES, {
  label: "candidate-aa",
  replicates: 10,
  rng: mulberry32(22),
});
const driftArm = synthSnapshot(DRIFTED, {
  label: "candidate-drift",
  replicates: 10,
  rng: mulberry32(33),
});
const confirmArm = synthSnapshot(DRIFTED, {
  label: "confirm-drift",
  replicates: 10,
  rng: mulberry32(44),
});
const otherCorpus = synthSnapshot(CASES, {
  label: "against-another-corpus",
  replicates: 10,
  rng: mulberry32(55),
  corpusDigest: "a-different-rendered-corpus",
});

const RESULTS: ReadonlyMap<string, CompareResult> = new Map([
  ["A/A", compare(EVAL_CASES, baseline, quietArm, { seed: 7 })],
  ["drift", compare(EVAL_CASES, baseline, driftArm, { seed: 7 })],
  ["confirmed", compare(EVAL_CASES, baseline, driftArm, { seed: 7, confirmation: confirmArm })],
  ["mismatch", compare(EVAL_CASES, baseline, otherCorpus, { seed: 7 })],
]);

const resultFor = (name: string): CompareResult => RESULTS.get(name) as CompareResult;
const rowsFor = (name: string): readonly GateRow[] => gatesFor(resultFor(name));

describe("the printed ledger and the exit code are the same decision", () => {
  it("spans four verdicts, so the sweep below is a sweep and not four copies of one branch", () => {
    // The self-check. Two implementations of one decision agree trivially on a single input.
    expect([...RESULTS].map(([name, r]) => `${name}=${r.verdict}`)).toEqual([
      "A/A=NO_DRIFT",
      "drift=SUSPECTED_DRIFT",
      "confirmed=CONFIRMED_DRIFT",
      "mismatch=NOT_COMPARABLE",
    ]);
  });

  for (const gate of ["confirmed", "suspected"] as const) {
    for (const [name, result] of RESULTS) {
      it(`reads the same code off the ${name} rows as the detector does under the ${gate} gate`, () => {
        // THE test in this file. Nothing in a green run would reveal these two drifting apart,
        // because each half is individually coherent and only their agreement is the contract.
        expect(exitCodeFromGates(gatesFor(result), gate)).toBe(exitCodeFor(result, gate));
      });
    }
  }

  it("promotes a suspected metric to a failing exit only under the opt-in gate", () => {
    // The branch where the two implementations reason about different things: a verdict string on
    // one side, a count of FLAG rows in the metric area on the other. If this pair ever collapsed,
    // the sweep above would still pass on three of the four results.
    const rows = rowsFor("drift");
    expect(rows.some((r) => r.area === AREA_METRIC && r.status === "FLAG")).toBe(true);
    expect(exitCodeFromGates(rows, "confirmed")).toBe(0);
    expect(exitCodeFromGates(rows, "suspected")).toBe(1);
  });
});

describe("a comparison that never happened exits 2, and outranks everything", () => {
  it("fails comparability and returns 2 rather than 1 on a corpus mismatch", () => {
    // Distinct from a regression on purpose. A runbook that handles the two the same way sends
    // someone to read a model changelog about a prompt-template edit.
    const rows = rowsFor("mismatch");
    const comparability = rows.find((r) => r.area === AREA_COMPARABILITY);
    expect(comparability?.status).toBe("FAIL");
    expect(exitCodeFromGates(rows, "confirmed")).toBe(2);
    expect(exitCodeFromGates(rows, "suspected")).toBe(2);
    expect(exitCodeFor(resultFor("mismatch"))).toBe(2);
  });

  it("marks every metric NOT RUN rather than passing it, when nothing was ever measured", () => {
    // A metric nobody reached is not a metric that passed. Counting it as one is how a ledger of
    // NOT RUN rows comes to look like a clean build.
    const metrics = rowsFor("mismatch").filter((r) => r.area === AREA_METRIC);
    expect(metrics.length).toBe(GATING_METRICS.length);
    for (const row of metrics) {
      expect(row.status, row.name).toBe("NOT RUN");
      expect(row.detail, row.name).toContain("corpora differ");
    }
    expect(rowsFor("mismatch").find((r) => r.area === AREA_POWER)?.status).toBe("NOT RUN");
  });

  it("still outranks a metric FAIL, so misuse is never reported as a regression", () => {
    // Constructed rather than computed: a real CompareResult cannot hold both at once, and the
    // ordering rule inside `exitCodeFromGates` is exactly what guarantees it never has to.
    const rows: readonly GateRow[] = [
      {
        area: AREA_COMPARABILITY,
        name: "corpus digest",
        status: "FAIL",
        detail: "different corpora",
      },
      { area: AREA_METRIC, name: "quality", status: "FAIL", detail: "reproduced" },
    ];
    expect(exitCodeFromGates(rows, "confirmed")).toBe(2);
  });
});

describe("the ledger's vocabulary is closed and its identity row never fails a build", () => {
  for (const [name, result] of RESULTS) {
    it(`emits only known statuses and known areas on the ${name} result`, () => {
      // A status outside `ALL_GATE_STATUSES` is printed in the table and missing from the summary
      // counts underneath it, which is a counting error no reader can detect.
      const known = new Set(ALL_GATE_STATUSES);
      const areas = new Set([AREA_COMPARABILITY, AREA_METRIC, AREA_IDENTITY, AREA_POWER]);
      for (const row of gatesFor(result)) {
        expect(known.has(row.status), `${row.area}/${row.name} has status ${row.status}`).toBe(
          true,
        );
        expect(areas.has(row.area), `${row.area} is not a known area`).toBe(true);
        expect(row.detail.length, `${row.area}/${row.name} has no detail`).toBeGreaterThan(10);
      }
    });
  }

  it("never emits SKIPPED, because a CompareResult cannot know what a caller declined", () => {
    // The status stays in the vocabulary so a CLI that declined a slow gate can append its own row
    // to this same ledger and be printed and counted by the same code.
    for (const [name, result] of RESULTS) {
      const skipped = gatesFor(result).filter((r) => r.status === "SKIPPED");
      expect(skipped.map((r) => `${name}: ${r.name}`)).toEqual([]);
    }
  });

  it("keeps an identity change a FLAG, so a vendor re-tag can never fail a build", () => {
    // A fingerprint change is a fact with no p-value. Failing on it would make a re-tag of
    // identical weights indistinguishable from a regression, which is the confusion the module
    // exists to stop.
    const retagged = synthSnapshot(CASES, {
      label: "retagged",
      replicates: 10,
      rng: mulberry32(66),
      resolvedModel: "synthetic-model-2",
    });
    const result = compare(EVAL_CASES, baseline, retagged, { seed: 7 });
    const rows = gatesFor(result);
    expect(result.identityChanges.length).toBeGreaterThan(0);
    expect(rows.find((r) => r.area === AREA_IDENTITY)?.status).toBe("FLAG");
    expect(exitCodeFromGates(rows, "confirmed")).toBe(0);
    expect(exitCodeFromGates(rows, "suspected")).toBe(exitCodeFor(result, "suspected"));
  });
});

describe("a ledger with no FAIL in it never sets a non-zero default exit", () => {
  for (const [name, result] of RESULTS) {
    it(`holds the rule on the ${name} result`, () => {
      const rows = gatesFor(result);
      const failing = rows.filter((r) => r.status === "FAIL");
      if (failing.length === 0) expect(exitCodeFromGates(rows, "confirmed")).toBe(0);
      else expect(exitCodeFromGates(rows, "confirmed")).not.toBe(0);
    });
  }

  it("returns zero for a ledger of FLAG, NOT RUN and SKIPPED rows under the default gate", () => {
    // Stated directly as well as swept, because the sweep is conditional and a conditional
    // assertion is one refactor away from asserting nothing.
    const rows: readonly GateRow[] = [
      {
        area: AREA_COMPARABILITY,
        name: "corpus digest",
        status: "PASS",
        detail: "one rendered corpus",
      },
      { area: AREA_METRIC, name: "quality", status: "FLAG", detail: "cleared both nulls once" },
      {
        area: AREA_METRIC,
        name: "refusal",
        status: "NOT RUN",
        detail: "no MDE resolved at this n",
      },
      {
        area: AREA_METRIC,
        name: "schemaValid",
        status: "SKIPPED",
        detail: "declined by the caller",
      },
      { area: AREA_IDENTITY, name: "fingerprint", status: "FLAG", detail: "sha256 moved" },
      {
        area: AREA_POWER,
        name: "detectable effect",
        status: "FLAG",
        detail: "one metric had no MDE",
      },
    ];
    expect(exitCodeFromGates(rows, "confirmed")).toBe(0);
    // And the opt-in gate is the only thing that changes that, and only for a metric FLAG.
    expect(exitCodeFromGates(rows, "suspected")).toBe(1);
  });
});

describe("renderGates prints the rows it graded and says what NOT RUN means", () => {
  it("prints every row, the closed vocabulary with counts, and the exit-code sentence", () => {
    const rows = rowsFor("confirmed");
    const rendered = renderGates(rows);
    for (const row of rows) expect(rendered, `${row.area}/${row.name}`).toContain(row.name);
    for (const status of ALL_GATE_STATUSES) expect(rendered, status).toContain(status);
    expect(rendered).toContain("exit 1 under the default gate");
    expect(rendered).toContain("NOT RUN is not a pass");
  });

  it("keeps every line inside the rule width, including a truncated long detail", () => {
    // The ledger shares the report's 96 column rule. A row whose detail widened the whole table is
    // how a ledger stops being readable in the terminal it was designed for.
    for (const [name, result] of RESULTS) {
      const over = renderGates(gatesFor(result))
        .split("\n")
        .filter((line) => line.length > 96);
      expect(over.map((line) => `${name}: ${line.length} cols`)).toEqual([]);
    }
  });
});
