// The freeze validator, and the rule it exists for.
//
// The sibling `agent-context-containment` ships two FREEZE.json files with different field sets and
// nothing that type-checks either. A freeze record is an evidentiary document, and an evidentiary
// document with no schema is prose. THE rule this closes: a record must never claim a proof it does
// not carry, and must never be softened from `unavailable` to `pending`, because those are
// different claims.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type FreezeRecord,
  ageInDays,
  checkFreeze,
  formatFreezeViolations,
} from "../src/freeze.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const read = (split: string): FreezeRecord =>
  JSON.parse(readFileSync(`${REPO}corpus/${split}/FREEZE.json`, "utf8")) as FreezeRecord;

describe("the shipped freeze records", () => {
  for (const split of ["canary", "extended"]) {
    it(`${split} is valid`, () => {
      const record = read(split);
      const violations = checkFreeze(record);
      expect(violations, formatFreezeViolations(violations)).toEqual([]);
    });

    it(`${split} states UNAVAILABLE rather than pending, because it is not work that remains`, () => {
      const record = read(split);
      expect(record.state).toBe("unavailable");
      expect(record.frozenAtCommit).toBeNull();
      expect((record.reason ?? "").length).toBeGreaterThan(80);
    });

    it(`${split} says what is NOT proven, in its own field`, () => {
      // The half a reader will otherwise assume. Required to be present and to be substantive.
      expect(read(split).whatIsNotProven.length).toBeGreaterThan(60);
    });

    it(`${split} matches its case count`, () => {
      const record = read(split);
      expect(checkFreeze(record, record.caseCount)).toEqual([]);
      expect(checkFreeze(record, record.caseCount + 1).map((v) => v.code)).toContain(
        "FREEZE_COUNT_MISMATCH",
      );
    });
  }
});

describe("checkFreeze bites", () => {
  const base = read("canary");

  it("refuses a record that claims cashed with no commit behind it", () => {
    expect(checkFreeze({ ...base, state: "cashed" }).map((v) => v.code)).toContain(
      "FREEZE_STATE_COMMIT_DISAGREE",
    );
  });

  it("refuses a record that carries a commit while claiming the proof is unavailable", () => {
    // The other direction, and the one that would let a freeze be quietly half-claimed.
    const sha = "a".repeat(40);
    expect(checkFreeze({ ...base, frozenAtCommit: sha }).map((v) => v.code)).toContain(
      "FREEZE_STATE_COMMIT_DISAGREE",
    );
  });

  it("refuses an abbreviated commit, which can become ambiguous later", () => {
    expect(
      checkFreeze({ ...base, state: "cashed", frozenAtCommit: "abc1234" }).map((v) => v.code),
    ).toContain("FREEZE_MALFORMED_COMMIT");
  });

  it("refuses a non-cashed record with no reason", () => {
    const { reason: _drop, ...withoutReason } = base;
    expect(checkFreeze(withoutReason).map((v) => v.code)).toContain("FREEZE_MISSING_FIELD");
  });

  it("refuses a date it cannot compute staleness from", () => {
    expect(checkFreeze({ ...base, frozenAt: "August 2026" }).map((v) => v.code)).toContain(
      "FREEZE_MALFORMED_DATE",
    );
  });

  it("refuses an empty honesty field, which is where the load-bearing claim lives", () => {
    expect(checkFreeze({ ...base, whatIsNotProven: "  " }).map((v) => v.code)).toContain(
      "FREEZE_MISSING_FIELD",
    );
  });

  it("refuses an absent record rather than treating it as an empty one", () => {
    expect(checkFreeze(null).map((v) => v.code)).toEqual(["FREEZE_MISSING_FIELD"]);
  });

  it("returns every violation rather than the first", () => {
    const broken = { ...base, state: "cashed" as const, frozenAt: "nope", whatIsProven: "" };
    expect(new Set(checkFreeze(broken).map((v) => v.code)).size).toBeGreaterThan(2);
  });
});

describe("ageInDays", () => {
  it("takes the clock as an argument rather than reading one", () => {
    // Nothing in this package may read a clock: a staleness test must be able to state the date it
    // is asserting about.
    expect(ageInDays({ frozenAt: "2026-08-26" }, new Date("2026-08-26T12:00:00Z"))).toBe(0);
    expect(ageInDays({ frozenAt: "2026-08-26" }, new Date("2026-09-25T00:00:00Z"))).toBe(30);
  });
});
