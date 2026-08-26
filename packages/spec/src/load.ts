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
import { type EvalCase, SentinelError, type Split } from "./types.js";

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
 * Both splits, together, for the whole-corpus checks.
 *
 * `checkCorpus` runs again over the union because two of its rules are corpus-level rather than
 * case-level: the archetype span, and the requirement that not every case declare a detectionLimit.
 * Neither can be evaluated one split at a time, and the canary split alone would fail the span
 * check by design, since it is deliberately all constrained cases so it stays cheap enough to run
 * on every tick.
 */
export function loadCorpus(root: string): readonly EvalCase[] {
  const all = [
    ...loadSplit(join(root, "canary"), "canary"),
    ...loadSplit(join(root, "extended"), "extended"),
  ];
  const violations = checkCorpus(all, "corpus");
  if (violations.length > 0) {
    throw new SentinelError(
      "corpus_invalid",
      `the corpus as a whole is invalid:\n${formatCorpusViolations(violations)}`,
    );
  }
  return all;
}

/** The case files in a split directory, repo-root-relative, for manifest work. */
export function corpusFiles(dir: string, relativeTo: string): readonly string[] {
  return readdirSync(dir)
    .filter((f) => !SIDECARS.has(f))
    .map((f) => join(dir, f).slice(relativeTo.length + 1))
    .sort();
}
