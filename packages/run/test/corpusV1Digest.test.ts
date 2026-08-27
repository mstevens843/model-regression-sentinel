// THE MOST IMPORTANT ASSERTION IN THE v0.2 PASS: the v0.1 corpus digest did not move.
//
// `results/runs/` holds four real provider runs. 960 calls against a pinned alias, collected with
// real money, and they cannot be recollected: live provider calls were not authorised for the v0.2
// hardening pass, and a re-collection would in any case sample a different week of the provider that
// is the thing under observation. `results/calibration.json` and `results/CALIBRATION.md` are derived
// from those runs and go wherever they go.
//
// Each run stores a `corpusDigest` over the rendered requests of the 24 canary and extended cases.
// `compare` refuses two runs whose digests differ, and it is right to: two runs of different corpora
// differ by experiment rather than by provider. So if `loadV1Corpus` ever returns a different set,
// or a byte of those 24 cases changes, or `renderRequest` changes how a case becomes a request, the
// digest moves and every recorded run becomes NOT_COMPARABLE. That is the failure this file exists
// to make loud, immediately, rather than three commits later in a report that answers the wrong
// question with an old answer.
//
// WHY THIS TEST LIVES IN `run` AND NOT IN `spec`, where the rest of the corpus tests are. The digest
// is `corpusDigestOf`, which is exported from @model-regression-sentinel/run, and `run` depends on
// `spec`. A devDependency the other way would make the workspace graph cyclic and `turbo run build`
// would refuse it. The membership half of the same claim, that `loadV1Corpus` returns exactly those
// 24 ids and no schema case, is asserted in packages/spec/test/corpusV2.test.ts.
//
// IF THIS FAILS, DO NOT UPDATE THE EXPECTED DIGEST. That is the same move as regenerating a manifest
// to make `verify-corpus.sh` go green: it turns a working integrity check into decoration. Find out
// what changed. If a case genuinely must change, that is a new corpus version, cut beside the old
// one, with the old results still published and labelled.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_SPLITS, loadCorpus, loadSplit, loadV1Corpus } from "@model-regression-sentinel/spec";
import { describe, expect, it } from "vitest";
import { corpusDigestOf } from "../src/runner.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const CORPUS = join(REPO, "corpus");
const RUNS = join(REPO, "results", "runs");

interface RecordedRun {
  readonly label: string;
  readonly corpusDigest: string;
  readonly caseIds: readonly string[];
}

const readRun = (name: string): RecordedRun =>
  JSON.parse(readFileSync(join(RUNS, `${name}.json`), "utf8")) as RecordedRun;

const RECORDED = ["baseline", "candidate", "confirmation", "positive-control"] as const;

describe("the v0.1 corpus digest", () => {
  const v1 = loadV1Corpus(CORPUS);

  it("matches the digest recorded in results/runs/baseline.json", () => {
    // The whole point. Not a hard-coded constant: read from the recorded run, so the test is
    // asserting against the EVIDENCE rather than against a number somebody typed twice.
    const baseline = readRun("baseline");
    expect(corpusDigestOf(v1)).toBe(baseline.corpusDigest);
  });

  it("matches every one of the four recorded runs, not only the baseline", () => {
    // All four arms were collected against one corpus. If they ever disagree with each other, one of
    // them was collected against something else and no comparison among them means anything.
    const digest = corpusDigestOf(v1);
    for (const name of RECORDED) {
      expect(readRun(name).corpusDigest, `${name}.json disagrees`).toBe(digest);
    }
  });

  it("is taken over exactly the 24 case ids the recorded runs list", () => {
    const fromCorpus = [...v1.map((c) => String(c.id))].sort();
    expect(fromCorpus.length).toBe(24);
    expect(fromCorpus).toEqual([...readRun("baseline").caseIds].sort());
  });

  it("does NOT include the schema split, which is what keeps the recorded runs comparable", () => {
    // The negative control for the whole additive-growth argument. `loadCorpus` grew a third split
    // in v0.2; if `loadV1Corpus` had grown with it, this digest would have moved and all four runs
    // would answer NOT_COMPARABLE.
    expect(v1.some((c) => c.split === "schema")).toBe(false);
    const everything = loadCorpus(CORPUS);
    expect(everything.length).toBeGreaterThan(v1.length);
    expect(corpusDigestOf(everything)).not.toBe(corpusDigestOf(v1));
  });

  it("moves when a case changes, so its stability above is a measurement and not a tautology", () => {
    // A digest that could not move would prove nothing by not moving. Perturb one case IN MEMORY,
    // never on disk, and require the digest to notice.
    const perturbed = v1.map((c, i) =>
      i === 0 ? { ...c, input: { ...c.input, user: `${c.input.user} ` } } : c,
    );
    expect(corpusDigestOf(perturbed)).not.toBe(corpusDigestOf(v1));
  });

  it("ignores the order the cases were loaded in, because a reordering is not an edit", () => {
    expect(corpusDigestOf([...v1].reverse())).toBe(corpusDigestOf(v1));
  });

  it("covers every split the spec knows about, so a fourth one cannot be forgotten", () => {
    // A guard on the guard. If someone adds a split and forgets to write its cases, this fails here
    // rather than silently in a run that quietly measured fewer cases than it claimed.
    for (const split of ALL_SPLITS) {
      expect(loadSplit(join(CORPUS, split), split).length, `${split} is empty`).toBeGreaterThan(0);
    }
  });
});
