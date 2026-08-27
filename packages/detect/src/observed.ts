// Whether a collected arm was a look at the provider at all.
//
// "I LOOKED AND NOTHING CHANGED" AND "I COULD NOT LOOK" ARE OPPOSITE CLAIMS, and this file exists
// because one of them was being printed as the other.
//
// The watcher has always known this. `packages/watch/src/tick.ts` refuses to fold a round in which
// every call failed, returns `could_not_look` as its own status with its own exit code, and leaves
// the accumulated wealth exactly where it was. `compare` had no equivalent, and the consequence was
// not subtle: a candidate arm in which all 240 calls returned ECONNREFUSED produced
//
//     VERDICT   NO_DRIFT
//     EXIT      0
//     "no gating metric moved ... and the suite had the power to detect the effect sizes it
//      searched for."
//
// Every clause of that is false. `extractMetrics` drops errored calls, so no metric entered the
// map, no finding was produced, and the empty findings list fell through the verdict cascade into
// the branch that asserts the suite had power. The gate ledger in the SAME report marked all four
// gating metrics NOT RUN, so the two halves of one document contradicted each other.
//
// A PARTIAL OUTAGE IS A DIFFERENT THING AND IS ALREADY HANDLED WELL. With 20 of 24 cases dead the
// comparison degrades to INCONCLUSIVE, reports 4 cases and 214 errors, and says the power was not
// there. That is correct and is left alone. Only TOTAL failure inverted the claim, which is exactly
// the shape of bug that survives review: the degenerate case is the one nobody constructs.
//
// THE SENTENCE IS THE POINT, not the boolean. "could not look" is not actionable; "all 240 call(s)
// failed, the first with: ECONNREFUSED" is. Both callers return prose for the same reason.

import type { RunSnapshot } from "@model-regression-sentinel/run";

/**
 * Why this snapshot is not an observation, or null when it is one.
 *
 * `noun` names the thing in the caller's vocabulary - "round" for the watcher, "arm" for a
 * comparison - so one implementation can produce a sentence that reads correctly in both.
 */
export function observedNothing(snapshot: RunSnapshot, noun = "arm"): string | null {
  if (snapshot.records.length === 0) {
    return `this ${noun} recorded no calls at all.`;
  }
  const failed = snapshot.records.filter((r) => r.response.error !== "");
  if (failed.length === snapshot.records.length) {
    const first = failed[0];
    return `all ${failed.length} call(s) in this ${noun} failed${
      first === undefined ? "" : `, the first with: ${first.response.error}`
    }.`;
  }
  return null;
}

/** What a round has to match to be a look at a particular watched subject. */
export interface WatchSubject {
  readonly corpusDigest: string;
  readonly requestedModel: string;
}

/**
 * Why this round was not a look at `subject`, or null when it was.
 *
 * A round collected against a different corpus or a different alias is a failure to look rather
 * than a finding: accumulated evidence is a bet about ONE stream, and feeding it observations from
 * another does not produce a weaker result, it produces a meaningless one.
 */
export function whyItCouldNotLook(subject: WatchSubject, snapshot: RunSnapshot): string | null {
  if (snapshot.corpusDigest !== subject.corpusDigest) {
    return `this round was collected against corpus digest ${snapshot.corpusDigest} and the watch has been accumulating evidence against ${subject.corpusDigest}, so it is a look at a different question rather than a look at this one.`;
  }
  if (snapshot.requestedModel !== subject.requestedModel) {
    return `this round requested "${snapshot.requestedModel}" and the watch is pinned to "${subject.requestedModel}", so it is a look at a different subject.`;
  }
  return observedNothing(snapshot, "round");
}
