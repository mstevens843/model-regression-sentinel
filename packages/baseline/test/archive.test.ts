// The A/A archive: dealing one collected run into a pair in which DRIFT IS KNOWN TO BE ABSENT.
//
// WHAT THIS FILE PREVENTS. The number that comes out of this module is a false positive rate, and
// it ends up in a README. That makes every quiet defect here expensive in a way an ordinary bug is
// not: a split that leaked the same record into both arms, or handed the two arms different sample
// sizes, or drew from an unseeded generator, would still produce a plausible looking percentage and
// nobody reading the percentage could tell. So the properties asserted below are exactly the ones a
// reader of that percentage is entitled to assume and cannot check for themselves:
//
//   BOTH ARMS CARRY THE PARENT'S corpusDigest, because both halves genuinely were issued against
//   the same rendered requests. Any other value would be a lie that happened to make the pair
//   comparable to `compare`, which refuses a mismatched digest.
//
//   THE RECORDS PARTITION THE PARENT. A record in both arms is a record compared against itself,
//   which biases the pair toward looking identical, which biases the measured false positive rate
//   DOWN. That is the one direction a self-graded metric must never err in.
//
//   THE TWO ARMS HAVE THE SAME n. An A/A pair whose arms differ in sample size has a real
//   difference in it and a detector that noticed would be right.
//
//   THE DEAL IS REPRODUCIBLE FROM A SEED AND INDEPENDENT ACROSS SPLITS. A calibration that moves
//   between two runs over the same recorded data measures the machine rather than the detector, and
//   five hundred copies of one deal is one sample wearing the name of five hundred.
//
// THE FLOOR IS RAISED, NOT WORKED AROUND. Below four replicates a half is a single draw, and a
// false positive rate computed from single draws is a headline number with nothing behind it. The
// throw is asserted along with the count in its message, because "insufficient replicates" without
// the number sends the reader back to the data to find out how short they were.
//
// The generator is written out in this file rather than imported. `packages/baseline` deliberately
// does not depend on `@model-regression-sentinel/detect`, for the reason `archive.ts` gives about
// its own Fisher-Yates, and a test that reached across that line would make the boundary untrue.

import type { ProviderResponse, RunRecord, RunSnapshot } from "@model-regression-sentinel/run";
import { skipped } from "@model-regression-sentinel/run";
import { describe, expect, it } from "vitest";
import { MIN_REPLICATES_FOR_SPLIT, manyAaSplits, splitForAaControl } from "../src/archive.js";

/**
 * The project's own generator, copied rather than imported, for the reason in the header.
 *
 * Seeded and passed in everywhere. There is no `Math.random` in this file and there must never be:
 * an A/A study whose deal changes between two runs of the same suite is not a measurement.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ok = (outputTokens: number): ProviderResponse => ({
  ...skipped(""),
  error: "",
  outputTokens,
});

/** Every record carries a distinct `outputTokens`, so a duplicated draw is visible not inferred. */
function records(perCase: ReadonlyMap<string, number>): readonly RunRecord[] {
  const out: RunRecord[] = [];
  let token = 0;
  for (const [caseId, count] of perCase) {
    for (let r = 0; r < count; r += 1) {
      token += 1;
      out.push({
        caseId,
        replicate: r,
        promptId: "terse-v1",
        promptSha256: "p",
        requestSha256: `req-${caseId}`,
        response: ok(token),
      });
    }
  }
  return out;
}

function snapshot(perCase: ReadonlyMap<string, number>, replicates: number): RunSnapshot {
  const rows = records(perCase);
  return {
    schemaVersion: 1,
    label: "baseline",
    capturedAt: "2026-08-26T00:00:00.000Z",
    provider: "fixture",
    requestedModel: "fixture-alias",
    splits: ["canary"],
    replicates,
    concurrency: 1,
    caseIds: [...perCase.keys()].sort(),
    corpusDigest: "digest-of-the-rendered-corpus",
    fingerprint: {
      requestedModel: "fixture-alias",
      resolvedModel: "fixture-model-1",
      canonicalModel: "fixture-model-1",
      provider: "fixture",
      contextWindow: 200000,
      maxOutputTokens: 64000,
      costBasis: "list",
      serviceTier: "standard",
      sha256: "fp-fixture-model-1",
    },
    records: rows,
    errorCount: 0,
    cost: {
      model: "fixture-model-1",
      n: rows.length,
      meanInputTokens: 40,
      meanOutputTokens: 5,
      meanCacheReadTokens: 0,
      meanCacheCreateTokens: 0,
      harnessUsdPerCall: 0.001,
      bareApiUsdPerCall: 0.0009,
      rateCardDate: "2026-06-24",
      rateUnknown: false,
    },
  };
}

const even = (count: number, replicates: number): ReadonlyMap<string, number> =>
  new Map(
    Array.from({ length: count }, (_, i) => [
      `cse-c-${String(i + 1).padStart(3, "0")}`,
      replicates,
    ]),
  );

/** The identity of a draw, and the reason every response above got a distinct token count. */
const tokensOf = (s: RunSnapshot): readonly number[] =>
  s.records.map((r) => r.response.outputTokens).sort((a, b) => a - b);

describe("an A/A split is a pair with no drift in it", () => {
  const parent = snapshot(even(4, 10), 10);
  const pair = splitForAaControl(parent, mulberry32(20260826));

  it("carries the parent's corpusDigest into both arms, which is what makes the pair comparable", () => {
    expect(pair.a.corpusDigest).toBe(parent.corpusDigest);
    expect(pair.b.corpusDigest).toBe(parent.corpusDigest);
  });

  it("gives both arms the same n, because a difference in sample size is a real difference", () => {
    expect(pair.a.replicates).toBe(5);
    expect(pair.b.replicates).toBe(5);
    expect(pair.a.records.length).toBe(pair.b.records.length);
  });

  it("halves the replicates, which is why the rate it measures is an upper bound", () => {
    expect(pair.a.replicates).toBe(Math.floor(parent.replicates / 2));
  });

  it("partitions the parent's records rather than sampling them with replacement", () => {
    // The property nobody reading the resulting percentage can check for themselves. A record dealt
    // into both arms is a record compared against itself, and it biases the measured false positive
    // rate DOWN, which is the one direction a self-graded number may never err in.
    const dealt = [...tokensOf(pair.a), ...tokensOf(pair.b)].sort((x, y) => x - y);
    expect(dealt).toEqual(tokensOf(parent));
    expect(new Set(dealt).size).toBe(parent.records.length);
  });

  it("keeps the two arms disjoint, stated separately from the partition so a failure names which", () => {
    const inA = new Set(tokensOf(pair.a));
    expect(tokensOf(pair.b).filter((t) => inA.has(t))).toEqual([]);
  });

  it("renumbers each arm's replicates so a half reads as an ordinary run", () => {
    // Carrying the parent's indices through would leave gaps that look like dropped calls to
    // anything counting them.
    for (const arm of [pair.a, pair.b]) {
      const byCase = new Map<string, number[]>();
      for (const record of arm.records) {
        const bucket = byCase.get(record.caseId) ?? [];
        bucket.push(record.replicate);
        byCase.set(record.caseId, bucket);
      }
      for (const [caseId, indices] of byCase) {
        expect(
          indices.sort((x, y) => x - y),
          caseId,
        ).toEqual([0, 1, 2, 3, 4]);
      }
    }
  });

  it("labels the arms so a report cannot mistake a half for the run it came from", () => {
    expect(pair.a.label).toBe("aa-a");
    expect(pair.b.label).toBe("aa-b");
    expect(pair.a.caseIds).toEqual(parent.caseIds);
  });

  it("cuts every case at the smallest case's half rather than per case", () => {
    // The both-halves-same-size rule. Cases hold different numbers of replicates once errors are
    // dropped, and an A/A pair whose arms differ in n is not an A/A pair.
    const ragged = splitForAaControl(
      snapshot(
        new Map([
          ["cse-c-001", 10],
          ["cse-c-002", 6],
        ]),
        10,
      ),
      mulberry32(7),
    );
    expect(ragged.a.replicates).toBe(3);
    expect(ragged.a.records.length).toBe(6);
    expect(ragged.b.records.length).toBe(6);
  });
});

describe("the deal is reproducible from a seed and independent across splits", () => {
  const parent = snapshot(even(3, 8), 8);
  const summarise = (
    pairs: readonly { readonly a: RunSnapshot }[],
  ): readonly (readonly number[])[] => pairs.map((p) => tokensOf(p.a));

  it("produces byte-identical splits from two generators seeded the same way", () => {
    // A calibration that moves between two runs over the same recorded data is a measurement of the
    // machine it ran on, and this number ends up in a README.
    expect(summarise(manyAaSplits(parent, mulberry32(4242), 5))).toEqual(
      summarise(manyAaSplits(parent, mulberry32(4242), 5)),
    );
  });

  it("produces DIFFERENT deals within one run, so five hundred splits are five hundred samples", () => {
    // The negative control for the test above. One generator threaded through every split is what
    // makes the deals independent; reseeding per split would return five hundred copies of one pair
    // and the reproducibility test alone would still pass.
    const splits = summarise(manyAaSplits(parent, mulberry32(4242), 5));
    expect(splits[0]).not.toEqual(splits[1]);
  });

  it("returns exactly the count it was asked for, and nothing for a count of zero", () => {
    expect(manyAaSplits(parent, mulberry32(1), 3).length).toBe(3);
    expect(manyAaSplits(parent, mulberry32(1), 0)).toEqual([]);
    expect(manyAaSplits(parent, mulberry32(1), -4)).toEqual([]);
  });
});

describe("a run too thin to split raises rather than answering quietly", () => {
  it("refuses below MIN_REPLICATES_FOR_SPLIT and names the count it found", () => {
    // Without the count, the reader goes back to the data to find out how short they were. The
    // floor itself is in the message too, so a caller can tell how far off they are in one read.
    const thin = snapshot(even(2, MIN_REPLICATES_FOR_SPLIT - 1), MIN_REPLICATES_FOR_SPLIT - 1);
    expect(() => splitForAaControl(thin, mulberry32(1))).toThrowError(
      new RegExp(`cse-c-001 has ${MIN_REPLICATES_FOR_SPLIT - 1}`),
    );
    expect(() => splitForAaControl(thin, mulberry32(1))).toThrowError(
      new RegExp(`at least ${MIN_REPLICATES_FOR_SPLIT} replicates per case`),
    );
  });

  it("carries the insufficient_replicates code, so a caller can branch without reading prose", () => {
    const thin = snapshot(even(1, 2), 2);
    const code = (() => {
      try {
        splitForAaControl(thin, mulberry32(1));
        return "no throw";
      } catch (cause) {
        return (cause as { readonly code?: string }).code ?? "no code";
      }
    })();
    expect(code).toBe("insufficient_replicates");
  });

  it("refuses a snapshot with no recorded replicates at all", () => {
    // Distinct message, because zero cases and thin cases send a caller to different places: one is
    // a collection that never happened, the other is a collection that was too small.
    expect(() => splitForAaControl(snapshot(new Map(), 0), mulberry32(1))).toThrowError(
      /holds 0 case\(s\) with recorded replicates/,
    );
  });

  it("accepts exactly MIN_REPLICATES_FOR_SPLIT, so the floor is a floor and not a fence", () => {
    const atFloor = splitForAaControl(
      snapshot(even(2, MIN_REPLICATES_FOR_SPLIT), MIN_REPLICATES_FOR_SPLIT),
      mulberry32(1),
    );
    expect(atFloor.a.replicates).toBe(Math.floor(MIN_REPLICATES_FOR_SPLIT / 2));
  });
});
