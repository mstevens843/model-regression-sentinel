// The A/A archive: measuring this tool's own false positive rate out of a run somebody already paid
// for.
//
// THE PROBLEM. A drift detector's headline number is how often it says "drift" when nothing drifted,
// and there is no way to read that off a single comparison, because a comparison of two real runs
// has no ground truth in it. The obvious way to get ground truth is to collect two runs of the same
// corpus against the same provider in the same window and check how often the detector fires on the
// pair. That works, and it doubles the cost of every baseline forever, which means in practice it
// gets done once, at the start, and never again.
//
// THE SPLIT DOES IT FOR FREE. A collected run already holds several replicates per case, drawn from
// the same provider, in the same window, against the same rendered corpus. Deal them randomly into
// two halves and you have a PAIR IN WHICH DRIFT IS KNOWN TO BE ABSENT, because there is nowhere for
// drift to have come from. Run the detector on it. Every time it says drift, that is a false
// positive, and it cost nothing but arithmetic. Repeat the deal a few hundred times and the rate is
// measured rather than assumed. This is the same mechanism `calibrateNull` uses inside the
// detector, promoted to whole snapshots so the WHOLE PIPELINE gets graded rather than one statistic
// in the middle of it.
//
// THE HALVES HAVE HALF THE REPLICATES, SO THE MEASURED RATE IS CONSERVATIVE. This is the cost, and
// it is stated here rather than left for whoever wonders why the number looks pessimistic. A real
// comparison puts n replicates against n. An A/A pair built this way puts n/2 against n/2, so every
// statistic in it is computed at a smaller sample size and is correspondingly noisier, and a noisier
// statistic crosses a fixed threshold more often. THE FALSE POSITIVE RATE MEASURED HERE IS THEREFORE
// AN UPPER BOUND ON THE RATE THE REAL COMPARISON HAS. Erring toward reporting a worse number about
// this tool than the tool actually deserves is the right direction, and it is the only direction a
// self-graded metric is allowed to err in.
//
// WHAT AN A/A SPLIT DOES NOT ESTABLISH. Both halves come from ONE collection window. A provider that
// is stable within an hour and moves between days will look perfectly stable here, so this measures
// within-window nondeterminism and says nothing about between-window drift. That is exactly the
// quantity the detector needs a null for, so the split is the right instrument, but the number it
// produces must never be quoted as "the provider is stable".
//
// THE BOTH-HALVES-SAME-SIZE RULE. Cases may hold different numbers of replicates once errors are
// dropped, and the halves are cut at the smallest case's half rather than per case. An A/A pair
// whose two arms differ in n as well as in draw is not an A/A pair: it has a real difference in it,
// the difference is sample size, and a detector that noticed it would be right.

import type { RunRecord, RunSnapshot } from "@model-regression-sentinel/run";
import { SentinelError } from "@model-regression-sentinel/spec";

/** Two halves of one collected run. Same provider, same window, same corpus, different draw. */
export interface AaPair {
  readonly a: RunSnapshot;
  readonly b: RunSnapshot;
}

/**
 * The floor below which a case cannot be split.
 *
 * Four, matching `calibrateNull`. With three, one half is a single draw and the split measures
 * almost nothing; with two, each half is one draw and the "pair" is two coin flips wearing the name
 * of a suite. Below four the correct answer is that no A/A study is available from this run, and it
 * is raised rather than returned quietly, because a false positive rate computed from single draws
 * would be a headline number with nothing behind it.
 */
export const MIN_REPLICATES_FOR_SPLIT = 4;

/**
 * Deal one collected run into an A/A pair.
 *
 * `rng` is injected and never defaulted. A calibration that moves between two runs on the same
 * recorded data is not a measurement of the detector, it is a measurement of the machine it ran on,
 * and this number ends up in a README.
 */
export function splitForAaControl(snapshot: RunSnapshot, rng: () => number): AaPair {
  const byCase = groupByCase(snapshot.records);

  if (byCase.size === 0) {
    throw new SentinelError(
      "insufficient_replicates",
      `this snapshot holds 0 case(s) with recorded replicates, so there is nothing to split; an A/A control needs at least ${MIN_REPLICATES_FOR_SPLIT} replicates on every case`,
    );
  }

  const thin = [...byCase.entries()]
    .filter(([, records]) => records.length < MIN_REPLICATES_FOR_SPLIT)
    .map(([caseId, records]) => `${caseId} has ${records.length}`)
    .sort();
  if (thin.length > 0) {
    throw new SentinelError(
      "insufficient_replicates",
      `an A/A control needs at least ${MIN_REPLICATES_FOR_SPLIT} replicates per case, and ${thin.length} case(s) fall short: ${thin.join(", ")}. Splitting them anyway would produce halves of one or two draws, and a false positive rate measured from those describes the arithmetic rather than the provider`,
    );
  }

  const minReplicates = [...byCase.values()].reduce(
    (m, records) => Math.min(m, records.length),
    Number.POSITIVE_INFINITY,
  );
  const half = Math.floor(minReplicates / 2);

  const aRecords: RunRecord[] = [];
  const bRecords: RunRecord[] = [];
  for (const caseId of [...byCase.keys()].sort()) {
    const records = byCase.get(caseId) as readonly RunRecord[];
    const dealt = shuffled(rng, records);
    for (let i = 0; i < half; i += 1) {
      // Replicate indices are renumbered inside each half so that each arm reads as an ordinary run
      // of `half` replicates. Carrying the parent's indices through would leave gaps that look like
      // dropped calls to anything counting them.
      aRecords.push({ ...(dealt[i] as RunRecord), replicate: i });
      bRecords.push({ ...(dealt[half + i] as RunRecord), replicate: i });
    }
  }

  return {
    a: halfSnapshot(snapshot, "aa-a", half, aRecords),
    b: halfSnapshot(snapshot, "aa-b", half, bRecords),
  };
}

/**
 * Repeat the deal.
 *
 * One split is one sample of the null and tells you almost nothing; the rate is the point. The same
 * `rng` runs through every split rather than being reseeded per split, so the deals are independent
 * of one another and a caller cannot accidentally request five hundred copies of the same pair.
 */
export function manyAaSplits(
  snapshot: RunSnapshot,
  rng: () => number,
  count: number,
): readonly AaPair[] {
  const n = Math.max(0, Math.floor(count));
  const out: AaPair[] = [];
  for (let i = 0; i < n; i += 1) out.push(splitForAaControl(snapshot, rng));
  return out;
}

/**
 * One half, wearing the shape of an ordinary snapshot.
 *
 * `corpusDigest` is carried through UNCHANGED and that is load-bearing rather than lazy: the
 * detector refuses to compare two runs whose digests differ, and both halves were issued against
 * exactly the same rendered requests, so any other value here would be a lie that happened to make
 * the pair comparable. `capturedAt` and `fingerprint` are carried for the same reason, since both
 * halves genuinely were collected in that window under that identity.
 *
 * `cost` is carried verbatim and describes the PARENT collection rather than the half. Re-deriving
 * a per call cost from a subset would invent a figure nobody paid, and the cost block is already
 * expressed as means per call, which the half does not change.
 */
function halfSnapshot(
  parent: RunSnapshot,
  label: string,
  replicates: number,
  records: readonly RunRecord[],
): RunSnapshot {
  return {
    ...parent,
    label,
    replicates,
    caseIds: [...new Set(records.map((r) => r.caseId))].sort(),
    records,
    errorCount: records.filter((r) => r.response.error !== "").length,
  };
}

function groupByCase(records: readonly RunRecord[]): ReadonlyMap<string, readonly RunRecord[]> {
  const out = new Map<string, RunRecord[]>();
  for (const record of records) {
    const bucket = out.get(record.caseId);
    if (bucket === undefined) out.set(record.caseId, [record]);
    else bucket.push(record);
  }
  return out;
}

/**
 * Fisher-Yates over a copy.
 *
 * Written out rather than imported from `@model-regression-sentinel/detect`, which has one, because
 * this package deliberately does not depend on the detector: the archive has to be readable and
 * splittable by a caller who never runs `compare`, and a dependency edge from the store to the
 * statistics would make the store impossible to use without them.
 */
function shuffled<T>(rng: () => number, items: readonly T[]): readonly T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const swap = out[i] as T;
    out[i] = out[j] as T;
    out[j] = swap;
  }
  return out;
}
