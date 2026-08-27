// One look at the provider, and the four things a look is allowed to conclude.
//
// This is the file the rest of the package exists to serve, and every decision in it is about
// REFUSING TO COLLAPSE TWO DIFFERENT CLAIMS INTO ONE STATUS. A monitor's whole value is that its
// output means something specific, and every shortcut below has a version where it means less.
//
// "I LOOKED AND NOTHING CHANGED" AND "I COULD NOT LOOK" ARE OPPOSITE CLAIMS, AND ONLY ONE OF THEM IS
// EVER TRUE. If every record in the round errored, the provider was unreachable, the key was absent
// or the corpus underneath the watch was swapped, then this tick observed NOTHING, and a watcher
// that reports `quiet` for that is asserting something it has no evidence for. It is also the most
// dangerous possible failure, because an outage is exactly when a provider is most likely to be
// mid-change, and a green dashboard through a week of silent failures is how a canary becomes
// decoration. So `could_not_look` is its own status and its own exit code, no observation is folded
// into any e-process, and the wealth is left exactly where it was rather than being nudged by a
// round of zeros.
//
// A ROUND COLLECTED AGAINST A DIFFERENT CORPUS OR A DIFFERENT ALIAS IS ALSO A FAILURE TO LOOK, not a
// finding. The accumulated wealth is a bet about ONE stream, and feeding it observations from
// another stream does not produce a weaker result, it produces a meaningless one. `compare` calls
// this NOT_COMPARABLE and returns 2, the misuse code, because the caller handed it the wrong file.
// A watcher handed a round from another stream is in the same position and this used to share that
// code with it. It no longer does: as of v0.2 an unusable round returns 3, `could_not_look`,
// because from the watcher's side the common cause is a provider that would not answer rather than
// an operator who mistyped, and paging someone for a typo is how an alert channel gets muted. Both
// are still emphatically not 1, since neither is evidence the provider got worse.
//
// AN ALARM IS NOT A CONFIRMED REGRESSION AND MUST NOT FAIL A BUILD. `alarm_raised` means one case's
// e-process crossed 1/alpha. That crossing is a valid any-time rejection and it is worth a person's
// attention, and it is still ONE collection. Noise crosses a threshold on exactly the run where
// noise crosses it, and the report of that run is indistinguishable from a real one. A build that
// goes red on it goes red on noise, and the second time that happens the gate gets deleted, which
// costs more than the alarm was worth.
//
// CONFIRMATION IS A SECOND, INDEPENDENTLY COLLECTED ROUND AGREEING. `confirmed_drift` requires a
// case that ALREADY alarmed on an earlier tick to be alarmed again on a tick whose own evidence
// pointed the same way. "Its own evidence" is measured rather than assumed: `alarmed` is sticky by
// design, so a case that crossed last week is trivially still alarmed today, and a confirmation rule
// resting on the flag alone would confirm on the next tick that contained any data at all. What is
// checked instead is that THIS ROUND'S observations RAISED the wealth. Each observation multiplies
// wealth by (1 + lambda * (p0 - x)), which is above one on a failure and below one on a pass, so the
// round's log wealth rises exactly when the round itself was worse than the null it is betting
// against. That is the watcher's version of `compare`'s confirmation arm: one test at alpha becomes
// two, on separately collected data, which a person can reason about without a statistics textbook.
//
// IDENTITY IS ORTHOGONAL TO BEHAVIOUR AND THE NOTE MUST SAY BOTH. A fingerprint change is a FACT
// with no p-value: the provider reported a different identity for the same pinned alias. It can sit
// beside perfectly quiet behaviour, and it usually does, because a vendor can re-tag the same
// weights. So `identityChanges` is populated on every tick that saw one and the note always mentions
// it, while `identity_changed` is the STATUS only when nothing behavioral outranks it. It never
// substitutes for a behavioral finding and it never suppresses one.
//
// THE WATCH FILE RECORDS THE IDENTITY DIGEST, NOT THE WHOLE FINGERPRINT, so a tick can say the
// identity moved and cannot say which field moved. That is a real limitation and it is the right
// trade: the digest makes the check total and free on every tick, and the field level answer is
// available from `fingerprintDiff` the moment anyone has two snapshots, which is the situation in
// which they would act on it. The alert records the digest transition so the field level diff can be
// reconstructed later from the two runs.
//
// PURE WHERE IT CAN BE. `tick` reads no clock, touches no filesystem and calls no provider. It takes
// the round that was already collected and the instant it is being folded at, and returns the next
// watch file. That is what makes a drift-over-time sequence replayable: a test can hand it sixty
// synthetic rounds and assert the exact tick the status changed on.

import {
  type EProcessState,
  extractMetrics,
  observeMany,
  whyItCouldNotLook,
} from "@model-regression-sentinel/detect";
import type { FingerprintChange, RunSnapshot } from "@model-regression-sentinel/run";
import {
  EXIT_CONFIRMED_REGRESSION,
  EXIT_COULD_NOT_LOOK,
  EXIT_OK,
  type EvalCase,
} from "@model-regression-sentinel/spec";
import type { Confirmation, IdentityAlert, WatchFile } from "./state.js";

export interface TickInput {
  readonly file: WatchFile;
  readonly cases: readonly EvalCase[];
  /** The round that was just collected. One snapshot, whatever replicate count it was run at. */
  readonly snapshot: RunSnapshot;
  /** Injected. The tick is pure and its timestamps are data. */
  readonly now: Date;
}

/**
 * What one look concluded. Five values, and no two of them are rephrasings of each other.
 *
 *   `quiet`             observations were folded and no case is alarmed.
 *   `identity_changed`  the provider reported a different identity, and behaviour was quiet.
 *   `alarm_raised`      a case's e-process has crossed. Worth a look. Does NOT fail a build.
 *   `confirmed_drift`   an already alarmed case alarmed again on independently collected data.
 *   `could_not_look`    nothing was observed. See the header: this is not `quiet`.
 */
export type TickStatus =
  | "quiet"
  | "identity_changed"
  | "alarm_raised"
  | "confirmed_drift"
  | "could_not_look";

export interface TickResult {
  /** The next watch file. The caller persists it; `tick` itself writes nothing. */
  readonly file: WatchFile;
  readonly status: TickStatus;
  /** Every case alarmed AFTER this tick, not only the ones raised by it. Sorted. */
  readonly alarmedCases: readonly string[];
  readonly identityChanges: readonly FingerprintChange[];
  readonly note: string;
}

export function tick(input: TickInput): TickResult {
  const { file, snapshot, cases } = input;
  const at = input.now.toISOString();

  const blocked = whyItCouldNotLook(
    { corpusDigest: file.corpusDigest, requestedModel: file.requestedModel },
    snapshot,
  );
  if (blocked !== null) {
    // Nothing is folded and no identity is adopted. A round that was not a look at this watch's
    // subject must leave the accumulated evidence untouched, including the evidence about identity.
    return {
      file: { ...file, lastTickAt: at, ticks: file.ticks + 1 },
      status: "could_not_look",
      alarmedCases: alarmedIn(file.cases),
      identityChanges: [],
      note: `${blocked} No observation was folded into any e-process and the accumulated wealth is unchanged. This is not a report that nothing changed: this tick saw nothing at all, and those are opposite claims.`,
    };
  }

  const outcomes = roundOutcomes(cases, snapshot);

  const nextCases: EProcessState[] = [];
  const newConfirmations: Confirmation[] = [];
  const confirmedCases: string[] = [];
  const raisedCases: string[] = [];

  for (const before of file.cases) {
    const round = outcomes.get(before.caseId) ?? [];
    if (round.length === 0) {
      // A case the round did not cover. Left exactly as it was: a missing case is missing evidence,
      // and an e-process fed a round of nothing would report the same wealth while claiming a look.
      nextCases.push(before);
      continue;
    }

    const after = observeMany(before, round, file.config);
    nextCases.push(after);

    // The round's own evidence, independent of the sticky flag. See the header.
    const roundWasAdverse = after.logWealth > before.logWealth;

    if (after.alarmed && !before.alarmed) {
      raisedCases.push(after.caseId);
      newConfirmations.push({ at, caseId: after.caseId, confirmed: false });
    } else if (after.alarmed && before.alarmed && roundWasAdverse) {
      confirmedCases.push(after.caseId);
      newConfirmations.push({ at, caseId: after.caseId, confirmed: true });
    }
  }

  const observed = snapshot.fingerprint;
  const identityChanges: FingerprintChange[] =
    observed !== null && file.fingerprintSha256 !== "" && observed.sha256 !== file.fingerprintSha256
      ? [{ field: "sha256", before: file.fingerprintSha256, after: observed.sha256 }]
      : [];
  const newAlerts: IdentityAlert[] = identityChanges.map((change) => ({ at, ...change }));

  const nextFile: WatchFile = {
    ...file,
    lastTickAt: at,
    ticks: file.ticks + 1,
    // The new identity is ADOPTED. The alert fires once per change rather than on every tick from
    // here to the end of the watch, and `identityAlerts` is the permanent record that it happened.
    // A watcher that re-alerted forever is a watcher whose alerts get filtered.
    fingerprintSha256: observed?.sha256 ?? file.fingerprintSha256,
    cases: nextCases,
    identityAlerts: [...file.identityAlerts, ...newAlerts],
    confirmations: [...file.confirmations, ...newConfirmations],
  };

  const alarmedCases = alarmedIn(nextCases);
  const status: TickStatus =
    confirmedCases.length > 0
      ? "confirmed_drift"
      : alarmedCases.length > 0
        ? "alarm_raised"
        : identityChanges.length > 0
          ? "identity_changed"
          : "quiet";

  return {
    file: nextFile,
    status,
    alarmedCases,
    identityChanges,
    note: noteFor({
      status,
      alarmedCases,
      raisedCases: raisedCases.sort(),
      confirmedCases: confirmedCases.sort(),
      identityChanges,
      observations: [...outcomes.values()].reduce((a, o) => a + o.length, 0),
      coveredCases: outcomes.size,
    }),
  };
}

/**
 * Exit code for one tick.
 *
 * AN ALARM ALONE MUST NOT FAIL A BUILD. `alarm_raised` is a valid any-time rejection on a single
 * collection, and a single collection is exactly what noise crosses a threshold on. Failing here
 * would make the gate fire on noise, and a gate that fires on noise is a gate somebody removes.
 * `identity_changed` is a fact about a re-tag, not a regression, and re-tagging the same weights is
 * a thing vendors do; it is reported loudly and returns zero.
 *
 * BEING UNABLE TO LOOK IS A DISTINCT FAILURE FROM A REGRESSION, which is why it is 3 and not 1. The
 * two demand opposite responses: a 1 means investigate the provider's behaviour, a 3 means fix the
 * watcher, its credentials or its corpus, and a caller that cannot tell them apart will do the first
 * thing in response to the second and find nothing. This mirrors `exitCodeFor`, where
 * NOT_COMPARABLE is 2 because the tool was MISUSED, and an arm that never reached the provider is 3
 * because the invocation was fine and the world would not cooperate.
 */
export function tickExitCode(result: TickResult): number {
  // v0.2 splits what v0.1 collapsed. `could_not_look` used to return 2 alongside every other
  // misuse, and it is not misuse: the invocation was fine and the world would not cooperate. It now
  // returns EXIT_COULD_NOT_LOOK, so a pipeline can page an on-call for an outage and open a ticket
  // for a typo without having to parse prose to tell them apart. Neither is 1, because neither is
  // evidence that the provider got worse.
  if (result.status === "could_not_look") return EXIT_COULD_NOT_LOOK;
  if (result.status === "confirmed_drift") return EXIT_CONFIRMED_REGRESSION;
  return EXIT_OK;
}

// `whyItCouldNotLook` now lives in @model-regression-sentinel/detect, because `compare` needed the
// same question answered and answered identically. Two copies of "was this a look?" is how the two
// answers drift apart, and the version that drifts is always the one with fewer callers. See
// packages/detect/src/observed.ts for the argument.

/**
 * This round's pass/fail stream, per case.
 *
 * Graded from raw text through `extractMetrics`, which is the project's single grading path, so a
 * watch and a comparison can never disagree about what passed. Errored calls are dropped by
 * `extractMetrics` rather than scored as failures, and that is right here for the same reason it is
 * right there: a provider outage is not a quality regression, and folding a round of network errors
 * into the wealth would drive an alarm on an infrastructure problem and label it drift.
 */
function roundOutcomes(
  cases: readonly EvalCase[],
  snapshot: RunSnapshot,
): ReadonlyMap<string, readonly boolean[]> {
  const quality = extractMetrics(cases, snapshot).get("quality");
  const out = new Map<string, readonly boolean[]>();
  for (const samples of quality?.perCase ?? []) {
    if (samples.values.length === 0) continue;
    out.set(
      samples.caseId,
      samples.values.map((v) => v === 1),
    );
  }
  return out;
}

const alarmedIn = (states: readonly EProcessState[]): readonly string[] =>
  states
    .filter((s) => s.alarmed)
    .map((s) => s.caseId)
    .sort();

interface NoteInput {
  readonly status: TickStatus;
  readonly alarmedCases: readonly string[];
  readonly raisedCases: readonly string[];
  readonly confirmedCases: readonly string[];
  readonly identityChanges: readonly FingerprintChange[];
  readonly observations: number;
  readonly coveredCases: number;
}

/**
 * The sentence a person reads.
 *
 * Identity is appended to EVERY note that has an identity change in it, whatever the status, because
 * the two findings are orthogonal and a note that reported only the behavioral one would leave the
 * reader believing the provider's identity held.
 */
function noteFor(input: NoteInput): string {
  const looked = `Folded ${input.observations} observation(s) across ${input.coveredCases} case(s).`;

  let behaviour: string;
  if (input.status === "confirmed_drift") {
    behaviour = `${looked} ${input.confirmedCases.join(", ")} alarmed on an earlier tick and alarmed again on this independently collected round, whose own observations raised the wealth. Two separate collections now agree, which is the watcher's confirmation arm and is the only thing here that fails a build.`;
  } else if (input.status === "alarm_raised") {
    behaviour =
      input.raisedCases.length > 0
        ? `${looked} ${input.raisedCases.join(", ")} crossed 1/alpha on this tick. That is a valid any-time rejection and it is still a single collection: it is worth investigating and it is not yet a confirmed regression. Collect another round and see whether it agrees.`
        : `${looked} ${input.alarmedCases.join(", ")} remain(s) alarmed from an earlier tick, and this round's own evidence did not agree with it. Nothing here is confirmed.`;
  } else if (input.status === "identity_changed") {
    behaviour = `${looked} No case is alarmed, so the behaviour this suite can measure is quiet.`;
  } else {
    behaviour = `${looked} No case is alarmed and no identity moved.`;
  }

  if (input.identityChanges.length === 0) return behaviour;

  const moved = input.identityChanges
    .map((c) => `${c.field} went from ${c.before} to ${c.after}`)
    .join("; ");
  return `${behaviour} Separately, and orthogonally: the provider reported a different identity for the same pinned alias (${moved}). That is a fact rather than an inference and it has no p-value, and it is not by itself a regression, because a vendor can re-tag the same weights. It raises the priority of any behavioral finding beside it and it never substitutes for one. The watch file records the digest rather than the whole fingerprint, so run fingerprintDiff over the two snapshots to see which field actually moved.`;
}
