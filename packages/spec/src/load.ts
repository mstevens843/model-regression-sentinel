// Reading the corpus off disk.
//
// One file per subject area, plain JSON, no parser dependency. The format is chosen so that someone
// not using this library, or not using TypeScript, can consume the corpus with `JSON.parse` and
// nothing else. That matters more here than for an ordinary fixture set: the corpus is the
// instrument, and an instrument nobody outside the project can read is one nobody outside the
// project can check.
//
// A BAD CORPUS GRADES NOTHING, so this throws rather than returning a partial set. That is the
// opposite of the rule everywhere else in this package, where checkers return every violation, and
// the difference is deliberate: `checkCorpus` is a checker whose job is to enumerate problems,
// while `loadSplit` is a constructor whose postcondition is a usable corpus. Handing back half a
// corpus would let a run report a pass rate over whichever cases happened to parse.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkCorpus, formatCorpusViolations } from "./corpus.js";
import { SIDECARS } from "./manifest.js";
import { ALL_SPLITS, type EvalCase, SentinelError, type Split } from "./types.js";

/** Every case in one split directory, validated. Throws `corpus_invalid` if it is not usable. */
export function loadSplit(dir: string, split: Split): readonly EvalCase[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !SIDECARS.has(f))
    .sort();

  const cases: EvalCase[] = [];
  for (const f of files) {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (!Array.isArray(parsed)) {
      throw new SentinelError("corpus_invalid", `${f} is not an array of cases`);
    }
    cases.push(...(parsed as EvalCase[]));
  }

  const wrong = cases.filter((c) => c.split !== split);
  if (wrong.length > 0) {
    throw new SentinelError(
      "corpus_invalid",
      `${dir} contains ${wrong.length} case(s) not marked "${split}": ${wrong.map((c) => String(c.id)).join(", ")}`,
    );
  }

  // Case-level rules only. The two corpus-wide rules are checked by `loadCorpus` over the union;
  // see CheckScope in corpus.ts for why a split cannot satisfy them on its own.
  const violations = checkCorpus(cases, "split");
  if (violations.length > 0) {
    throw new SentinelError(
      "corpus_invalid",
      `corpus at ${dir} is invalid:\n${formatCorpusViolations(violations)}`,
    );
  }
  return cases;
}

/**
 * A named list of splits, together, with the corpus-wide checks run over the union.
 *
 * `checkCorpus` runs again over the union because two of its rules are corpus-level rather than
 * case-level: the archetype span, and the requirement that not every case declare a detectionLimit.
 * Neither can be evaluated one split at a time, and the canary split alone would fail the span
 * check by design, since it is deliberately all constrained cases so it stays cheap enough to run
 * on every tick.
 */
export function loadSplits(root: string, splits: readonly Split[]): readonly EvalCase[] {
  const all = splits.flatMap((s) => [...loadSplit(join(root, s), s)]);
  const violations = checkCorpus(all, "corpus");
  if (violations.length > 0) {
    throw new SentinelError(
      "corpus_invalid",
      `the corpus as a whole is invalid:\n${formatCorpusViolations(violations)}`,
    );
  }
  return all;
}

/** Every split this version of the spec knows about. What `compare` runs against by default. */
export function loadCorpus(root: string): readonly EvalCase[] {
  return loadSplits(root, ALL_SPLITS);
}

/**
 * EXACTLY the v0.1 pair, canary plus extended, and nothing else. Do not delete this.
 *
 * WHY IT EXISTS, in one sentence: `results/runs/baseline.json`, `candidate.json`,
 * `confirmation.json` and `positive-control.json` were collected against those two splits and no
 * other, at real cost, and each of them stores a `corpusDigest` computed over exactly those 24
 * rendered requests.
 *
 * `compare` refuses to compare two runs whose `corpusDigest` differs, and it is right to: two runs
 * of different corpora differ by experiment rather than by provider. So a `loadCorpus` that grew a
 * third split would silently make every recorded run NOT_COMPARABLE, and the four runs cannot be
 * recollected without paying for 960 more provider calls. Anything that reads those recorded runs -
 * `scripts/calibrate.mjs`, `results/CALIBRATION.md`, the A/A false-positive study, the power curve -
 * has to load the corpus through THIS function and not through `loadCorpus`.
 *
 * The digest it must produce is pinned by a test. See packages/run/test/corpusV1Digest.test.ts.
 */
export function loadV1Corpus(root: string): readonly EvalCase[] {
  return loadSplits(root, ["canary", "extended"]);
}

/** The case files in a split directory, repo-root-relative, for manifest work. */
export function corpusFiles(dir: string, relativeTo: string): readonly string[] {
  return readdirSync(dir)
    .filter((f) => !SIDECARS.has(f))
    .map((f) => join(dir, f).slice(relativeTo.length + 1))
    .sort();
}
