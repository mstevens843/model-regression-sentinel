// What a running watch remembers between ticks, and why it is a file rather than a process.
//
// A WATCH IS A SEQUENCE OF LOOKS AT ONE THING, AND THE EVIDENCE ACCUMULATES ACROSS THEM. That is
// what makes it different from `compare`, which is handed both arms at once and is finished when it
// returns. The e-process in `@model-regression-sentinel/detect` earns its any-time validity by
// carrying wealth forward from every observation it has ever seen, so the wealth is the watch: lose
// it and the guarantee is gone, because a watch that restarts its martingale on every tick is
// exactly the fixed-alpha test that fires once every twenty hours under a perfect null.
//
// SO THE STATE IS ON DISK, IN ONE FILE, IN CANONICAL JSON. Not in a daemon's memory, which dies with
// the machine, and not in a database, which would make the tool's smallest deployment a service.
// Canonical JSON for the same reason `packages/baseline` uses it: this file is generated, it is
// rewritten on every tick, and a serializer that emitted keys in insertion order would make the file
// churn in version control while nothing about the watch changed.
//
// THE FILE IS A LOG AS WELL AS A STATE. `identityAlerts` and `confirmations` are append-only lists
// and they are the only durable record that a thing happened at a time. The e-process states carry
// wealth and a sticky `alarmed` flag, which is enough to answer "is this case alarmed now" and not
// enough to answer "when did it first alarm, and did a later independently collected round agree".
// The second question is the one that separates a suspected finding from a confirmed one, and it can
// only be answered by something that remembers ticks rather than totals.
//
// THE WATCHED SUBJECT IS PINNED IN THE FILE. `corpusDigest`, `requestedModel` and `provider` are
// recorded at init and every tick checks them. A watch whose corpus was edited underneath it is not
// a watch that found something, it is a watch that changed the question, and the accumulated wealth
// is meaningless against a different corpus. `packages/detect` refuses a mismatched comparison for
// the same reason; this is the same rule applied over time.
//
// WHAT THIS IS NOT: a general purpose key value store, a migration path, or a merge point. A watch
// file has one writer. Two ticks racing on one file is a data loss bug that no amount of schema care
// prevents, and the scheduler is expected to serialize them, which every scheduler in
// `schedule.ts` does.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_ECONFIG,
  type EProcessConfig,
  type EProcessState,
  extractMetrics,
  startEProcess,
} from "@model-regression-sentinel/detect";
import type { RunSnapshot } from "@model-regression-sentinel/run";
import {
  type EvalCase,
  SentinelError,
  canonicalJson,
  parseJson,
} from "@model-regression-sentinel/spec";
import {
  type Lineage,
  type RotationPlan,
  freshLineage,
  identityOf,
  rotationRecord,
} from "./lineage.js";

/** One field of the provider identity moved, and when. Append-only: this is the permanent record. */
export interface IdentityAlert {
  readonly at: string;
  readonly field: string;
  readonly before: string;
  readonly after: string;
}

/**
 * One alarm event.
 *
 * `confirmed: false` is the first crossing on a case. `confirmed: true` is a later, independently
 * collected tick agreeing with it. Both are recorded, because the pair of them is the evidence, and
 * a list holding only confirmations could not distinguish a case that alarmed once and settled from
 * a case that has never alarmed at all.
 */
export interface Confirmation {
  readonly at: string;
  readonly caseId: string;
  readonly confirmed: boolean;
}

export interface WatchFile {
  /** A literal. A watch file is a durable artifact and there is no migration path by design. */
  readonly schemaVersion: 1;
  /** The corpus this wealth was accumulated against. A tick against another one is not a look. */
  readonly corpusDigest: string;
  /** What was ASKED for. An alias stays an alias, which is the point of watching one. */
  readonly requestedModel: string;
  readonly provider: string;
  readonly startedAt: string;
  readonly lastTickAt: string;
  /** Ticks ATTEMPTED, including ones that could not look. Observations are counted per case. */
  readonly ticks: number;
  /** The identity last observed. Empty string when no successful call has ever been made. */
  readonly fingerprintSha256: string;
  readonly config: EProcessConfig;
  readonly cases: readonly EProcessState[];
  readonly identityAlerts: readonly IdentityAlert[];
  readonly confirmations: readonly Confirmation[];
  /**
   * The watch's history across baselines. OPTIONAL, because a watch file is a durable artifact whose
   * `schemaVersion` is a literal 1 with no migration path, so evolution here is optional fields only
   * for the same reason it is on `EvalCase`. A file written before rotations existed genuinely has
   * no lineage, and reading its absence as generation 1 is the true statement about it.
   */
  readonly lineage?: Lineage;
}

/** Generation 1 with no rotations is the correct reading of a file that predates lineage. */
export const lineageOf = (file: WatchFile): Lineage =>
  file.lineage ?? {
    generation: 1,
    baseline: {
      label: "unrecorded",
      capturedAt: file.startedAt,
      corpusDigest: file.corpusDigest,
      replicates: 0,
      fingerprintSha256: file.fingerprintSha256,
    },
    rotations: [],
  };

/** Everything needed to start a watch. An options object because a watch is pinned to four things. */
export interface InitWatchInput {
  /** The reference run. Its quality rate per case becomes the null each e-process bets against. */
  readonly snapshot: RunSnapshot;
  readonly cases: readonly EvalCase[];
  /** Injected, never a clock read. A watch file's timestamps are data. */
  readonly now: Date;
  readonly config?: EProcessConfig;
}

/**
 * Build a watch file from a baseline snapshot.
 *
 * THE BASELINE IS GRADED HERE, FROM RAW TEXT, rather than read back from a stored verdict, because
 * `extractMetrics` is the only thing in this project allowed to decide what passed and a second
 * grading path is a second answer waiting to disagree with the first. It also means a grader fix
 * changes what a NEW watch bets against without anyone re-collecting anything.
 *
 * ONLY `quality` SEEDS THE WATCH. The e-process is a bet on a pass/fail stream and quality is the
 * one metric that is pass/fail, is gating, and means the same thing on every archetype in the
 * corpus. `refusal` and `schemaValid` are also binary and are deliberately left to `compare`: a
 * refusal stream is already folded into quality by the `nonRefusal` grader, and `schemaValid` only
 * exists on schema cases, so a watch seeded from it would silently cover a subset of the corpus
 * while presenting a suite-wide number.
 *
 * A case with no gradable quality replicate in the baseline gets NO watch, rather than a watch
 * seeded from nothing. `startEProcess` would happily accept 0 of 0, the Wilson bound would come back
 * NaN, and the clamp inside it would turn that into a p0 of 0.5, which is a confident bet against a
 * rate nobody measured.
 */
export function initWatchFile(input: InitWatchInput): WatchFile {
  const config = input.config ?? DEFAULT_ECONFIG;
  const quality = extractMetrics(input.cases, input.snapshot).get("quality");
  const at = input.now.toISOString();

  const cases: EProcessState[] = [];
  for (const samples of quality?.perCase ?? []) {
    if (samples.values.length === 0) continue;
    const successes = samples.values.reduce((a, x) => a + x, 0);
    cases.push(startEProcess(samples.caseId, successes, samples.values.length, config));
  }
  cases.sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0));

  return {
    schemaVersion: 1,
    lineage: freshLineage(identityOf(input.snapshot)),
    corpusDigest: input.snapshot.corpusDigest,
    requestedModel: input.snapshot.requestedModel,
    provider: input.snapshot.provider,
    startedAt: at,
    lastTickAt: at,
    ticks: 0,
    // Empty rather than a placeholder when the baseline never reached the provider. A tick that then
    // observes an identity ADOPTS it silently: a first observation is not a change, and reporting it
    // as one would open every watch with a false identity alert.
    fingerprintSha256: input.snapshot.fingerprint?.sha256 ?? "",
    config,
    cases,
    identityAlerts: [],
    confirmations: [],
  };
}

/**
 * Read a watch file, validated.
 *
 * Throws with EVERY problem it found rather than the first. A file written by an older version is
 * usually wrong in several ways at once, and one round trip per problem is a bad afternoon.
 */
export function readWatchFile(path: string): WatchFile {
  const parsed = parseJson(readFileSync(path, "utf8"));
  if (!parsed.ok) {
    throw new SentinelError("corpus_invalid", `${path} is not JSON: ${parsed.error}`);
  }
  const body = parsed.value;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new SentinelError("corpus_invalid", `${path} is not a watch file object`);
  }

  const record = body as { readonly [key: string]: unknown };
  const problems: string[] = [];
  if (record.schemaVersion !== 1) {
    problems.push(
      `schemaVersion is ${String(record.schemaVersion)} and this reader only understands 1`,
    );
  }
  const strings = [
    "corpusDigest",
    "requestedModel",
    "provider",
    "startedAt",
    "lastTickAt",
  ] as const;
  for (const field of strings) {
    if (typeof record[field] !== "string") problems.push(`${field} is missing or is not a string`);
  }
  for (const field of ["cases", "identityAlerts", "confirmations"] as const) {
    if (!Array.isArray(record[field])) problems.push(`${field} is missing or is not an array`);
  }
  if (typeof record.ticks !== "number") problems.push("ticks is missing or is not a number");
  if (record.config === null || typeof record.config !== "object") {
    problems.push(
      "config is missing; a watch whose alpha and alternative are unknown cannot say what its alarm would mean",
    );
  }

  if (problems.length > 0) {
    throw new SentinelError(
      "corpus_invalid",
      `${path} is not a usable watch file:\n${problems.map((p) => `  ${p}`).join("\n")}`,
    );
  }
  return body as unknown as WatchFile;
}

/**
 * Write a watch file.
 *
 * Canonical JSON, so a tick that changed nothing about the watch produces the same bytes and a diff
 * of two ticks shows what actually moved rather than a reshuffled object.
 */
export function writeWatchFile(path: string, file: WatchFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, canonicalJson(file), "utf8");
}

/**
 * Apply an approved rotation, producing the next generation of a watch.
 *
 * WHAT SURVIVES AND WHAT DOES NOT, and the split is the whole point:
 *
 *   survives   identity alerts, confirmations, and every previous rotation. These are the permanent
 *              record. A watch on its fourth baseline must not be able to present itself as one that
 *              started this morning, and this is what stops it.
 *
 *   does NOT   the e-process wealth, and it must not. A new baseline means a new `p0`, so the old
 *              wealth was accumulated betting against a different null. Carrying it forward would be
 *              arithmetic across two different questions, which is exactly the error the corpus
 *              digest guard prevents on the compare side.
 *
 * `ticks` resets because it counts ticks of THIS generation. `lifetimeTicks` in lineage.ts is how a
 * report recovers the total, and it is what any honest summary should print.
 *
 * Takes an approved `RotationPlan` rather than deciding for itself, so that the refusal rules live
 * in one place and cannot be bypassed by calling the applier directly.
 */
export function rotateWatchFile(
  file: WatchFile,
  plan: RotationPlan,
  input: InitWatchInput,
): WatchFile {
  const seeded = initWatchFile(input);
  const at = input.now.toISOString();
  const previous = lineageOf(file);
  return {
    ...seeded,
    lineage: {
      generation: previous.generation + 1,
      baseline: plan.to,
      rotations: [...previous.rotations, rotationRecord(plan, file.cases, file.ticks, at)],
    },
    // The permanent record, carried across the boundary.
    identityAlerts: file.identityAlerts,
    confirmations: file.confirmations,
  };
}
