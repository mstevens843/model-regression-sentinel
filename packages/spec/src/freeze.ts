// FREEZE.json: the claim a frozen corpus makes about itself, and the validator the sibling lacks.
//
// MANIFEST.sha256 proves the bytes have not changed since a digest was recorded. That is worth
// having and it is weaker than it sounds, because anyone who can edit the corpus can edit the
// manifest in the same change. The stronger property - that the corpus existed at a commit where
// the engine did not - is a claim only a git object can carry, and FREEZE.json is where that claim
// and its status live.
//
// WHY A VALIDATOR EXISTS HERE AND NOT IN THE SIBLING. `agent-context-containment` ships two
// FREEZE.json files with DIFFERENT FIELD SETS and nothing that type-checks either: v1 has `state`,
// `attempt` and `lesson`; v2 has `verify` and `honesty` and neither of the others. Nothing is wrong
// with either file, and nothing would have caught it if something were. A freeze record is an
// evidentiary document, and an evidentiary document with no schema is prose.
//
// THE ONE RULE THAT MATTERS: a freeze record must never be softened. `state: "unavailable"` and
// `state: "pending"` are different claims - the first says the proof cannot be obtained here, the
// second says it has not been obtained yet - and `checkFreeze` refuses a record that carries a
// commit while claiming the proof is unavailable, or claims the proof is cashed while carrying no
// commit. A freeze check that can be talked into agreeing with itself is worth less than no freeze
// check, because it looks like evidence.

import type { Split } from "./types.js";

/**
 * Whether the ordering proof was obtained, and if not, which kind of not.
 *
 *   `cashed`               a commit is recorded and it witnesses a tree with no engine in it.
 *   `attempted_and_failed` a commit was recorded and rejected. The record says which and why.
 *   `unavailable`          the proof cannot be obtained in this repository. Not the same as
 *                          pending, and specifically not to be written as pending.
 *   `pending`              obtainable, not yet done. The only state that implies future work.
 */
export type FreezeState = "cashed" | "attempted_and_failed" | "unavailable" | "pending";

const STATES: ReadonlySet<string> = new Set<FreezeState>([
  "cashed",
  "attempted_and_failed",
  "unavailable",
  "pending",
]);

export interface FreezeRecord {
  /** The split's own generation, not a schema version. A second freeze of the same split is v2. */
  readonly version: number;
  readonly split: Split;
  readonly caseCount: number;
  /** ISO date, day precision. What the staleness horizon is measured from. */
  readonly frozenAt: string;
  /** 40 lowercase hex, or null. Null is a real answer and carries a `state` explaining it. */
  readonly frozenAtCommit: string | null;
  readonly state: FreezeState;
  /** Narrow, checkable, and true. What a reader may rely on. */
  readonly whatIsProven: string;
  /** The half a reader will otherwise assume. Required, and required to be non-empty. */
  readonly whatIsNotProven: string;
  /** Why the state is what it is. Required unless `cashed`. */
  readonly reason?: string;
  /** The recipe, for whoever builds the next repository. */
  readonly howToCashInAFutureRepository?: readonly string[];
  /** The standing instruction against making this pass by weakening it. */
  readonly doNot: string;
}

export type FreezeViolationCode =
  /** A required field is absent or empty. */
  | "FREEZE_MISSING_FIELD"
  /** `state` is not one of the four. */
  | "FREEZE_UNKNOWN_STATE"
  /** `frozenAtCommit` is neither null nor 40 lowercase hex. An abbreviation can become ambiguous. */
  | "FREEZE_MALFORMED_COMMIT"
  /** The state and the commit contradict each other. See the header: this is THE rule. */
  | "FREEZE_STATE_COMMIT_DISAGREE"
  /** `caseCount` disagrees with the corpus it claims to cover. */
  | "FREEZE_COUNT_MISMATCH"
  /** `frozenAt` is not an ISO date, so the staleness horizon cannot be computed from it. */
  | "FREEZE_MALFORMED_DATE";

export interface FreezeViolation {
  readonly code: FreezeViolationCode;
  readonly message: string;
}

const SHA = /^[0-9a-f]{40}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate a freeze record. Pure, and returns every violation rather than the first.
 *
 * `actualCaseCount` is passed rather than read, so this stays pure and so the same function can
 * check a record against a corpus loaded from anywhere.
 */
export function checkFreeze(
  record: Partial<FreezeRecord> | null | undefined,
  actualCaseCount?: number,
): readonly FreezeViolation[] {
  const out: FreezeViolation[] = [];
  const push = (code: FreezeViolationCode, message: string): void => {
    out.push({ code, message });
  };

  if (record === null || record === undefined || typeof record !== "object") {
    push("FREEZE_MISSING_FIELD", "the freeze record is absent or is not an object");
    return out;
  }

  const nonEmpty = (field: keyof FreezeRecord): boolean => {
    const v = record[field];
    return typeof v === "string" && v.trim().length > 0;
  };

  for (const field of ["whatIsProven", "whatIsNotProven", "doNot"] as const) {
    if (!nonEmpty(field)) {
      push("FREEZE_MISSING_FIELD", `${field} is required and must be a non-empty string`);
    }
  }
  if (typeof record.version !== "number" || !Number.isInteger(record.version)) {
    push("FREEZE_MISSING_FIELD", "version is required and must be an integer");
  }
  if (typeof record.caseCount !== "number" || !Number.isInteger(record.caseCount)) {
    push("FREEZE_MISSING_FIELD", "caseCount is required and must be an integer");
  }
  if (!nonEmpty("frozenAt")) {
    push("FREEZE_MISSING_FIELD", "frozenAt is required");
  } else if (!ISO_DAY.test(record.frozenAt as string)) {
    push(
      "FREEZE_MALFORMED_DATE",
      `frozenAt "${String(record.frozenAt)}" is not YYYY-MM-DD, so baseline staleness cannot be computed from it`,
    );
  }

  const state = record.state;
  if (typeof state !== "string" || !STATES.has(state)) {
    push(
      "FREEZE_UNKNOWN_STATE",
      `state "${String(state)}" is not one of ${[...STATES].join(", ")}`,
    );
  }

  const commit = record.frozenAtCommit;
  const commitPresent = typeof commit === "string" && commit.length > 0;
  if (commit !== null && commit !== undefined && !SHA.test(String(commit))) {
    push(
      "FREEZE_MALFORMED_COMMIT",
      `frozenAtCommit "${String(commit)}" is not 40 lowercase hex; use the full hash, since an abbreviation can become ambiguous later`,
    );
  }

  // THE rule. Both directions.
  if (state === "cashed" && !commitPresent) {
    push(
      "FREEZE_STATE_COMMIT_DISAGREE",
      'state is "cashed" but no commit is recorded, so the record claims a proof it does not carry',
    );
  }
  if ((state === "unavailable" || state === "pending") && commitPresent) {
    push(
      "FREEZE_STATE_COMMIT_DISAGREE",
      `state is "${state}" but a commit is recorded; either the proof was cashed and the state is wrong, or the commit does not witness what the state says`,
    );
  }
  if (state !== "cashed" && !nonEmpty("reason")) {
    push("FREEZE_MISSING_FIELD", `state is "${String(state)}" so reason is required`);
  }

  if (
    actualCaseCount !== undefined &&
    typeof record.caseCount === "number" &&
    record.caseCount !== actualCaseCount
  ) {
    push(
      "FREEZE_COUNT_MISMATCH",
      `caseCount says ${record.caseCount} and the corpus holds ${actualCaseCount}`,
    );
  }

  return out;
}

/** Human-readable violations, one per line. */
export const formatFreezeViolations = (violations: readonly FreezeViolation[]): string =>
  violations.map((v) => `  ${v.code}: ${v.message}`).join("\n");

/**
 * Days since the freeze, for the staleness horizon.
 *
 * `now` is a parameter rather than a call to `Date.now`, so nothing in this package reads a clock
 * and a staleness test can state the date it is asserting about.
 */
export function ageInDays(record: Pick<FreezeRecord, "frozenAt">, now: Date): number {
  const then = Date.parse(`${record.frozenAt}T00:00:00Z`);
  if (Number.isNaN(then)) return Number.NaN;
  return Math.floor((now.getTime() - then) / 86_400_000);
}
