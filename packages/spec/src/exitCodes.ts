// The exit-code contract, in one place, because it is the product.
//
// Everything else this tool prints is for a person. The exit code is what a pipeline reads, and it
// is the one output that must never be wrong. v0.1 shipped three values and collapsed two different
// failures into one of them; v0.2 splits them, because the collapsed pair are opposite claims.
//
//   0  NO CONFIRMED REGRESSION. Includes NO_DRIFT, INCONCLUSIVE and SUSPECTED_DRIFT. A suspected
//      finding is printed loudly and returns zero, because a threshold is crossed by noise on
//      exactly the run where noise crosses it, and a build that fails on a single crossing is a
//      build whose gate gets removed the second time it happens.
//
//   1  CONFIRMED REGRESSION. A gating metric cleared both nulls AND reproduced on an independently
//      collected arm. This is the only value that fails a build.
//
//   2  MISUSE. Bad flags, an unreadable file, two runs of different corpora, a missing artifact.
//      The tool was asked to do something it cannot do. Fixing it means changing the invocation.
//
//   3  COULD NOT LOOK. The provider was unreachable, no credential was present, or a rate limit
//      stopped the round. The tool was asked to do something reasonable and the world would not
//      let it.
//
// WHY 2 AND 3 ARE NOT THE SAME NUMBER, and this is the change that matters. v0.1 returned 2 for
// both. A watcher that cannot reach its provider and a watcher that was pointed at the wrong file
// are different events with different owners: one is an incident, the other is a typo. A pipeline
// that cannot tell them apart will eventually alert the wrong person, or worse, learn to ignore
// both. Neither is 1, because neither is evidence that the provider got worse, and reporting an
// outage as a regression is the fastest way to make a drift gate untrustworthy.

/** The four values. A closed set: anything outside it is a bug in this tool, not a signal. */
export type ExitCode = 0 | 1 | 2 | 3;

export const EXIT_OK: ExitCode = 0;
export const EXIT_CONFIRMED_REGRESSION: ExitCode = 1;
export const EXIT_MISUSE: ExitCode = 2;
export const EXIT_COULD_NOT_LOOK: ExitCode = 3;

export interface ExitCodeMeaning {
  readonly code: ExitCode;
  readonly name: string;
  /** One line, for `--help` and for a report footer. */
  readonly meaning: string;
  /** What a person should do about it. */
  readonly action: string;
}

export const EXIT_CODES: readonly ExitCodeMeaning[] = [
  {
    code: 0,
    name: "no confirmed regression",
    meaning: "nothing was confirmed, which includes NO_DRIFT, INCONCLUSIVE and SUSPECTED_DRIFT",
    action: "read the verdict: INCONCLUSIVE is not the same claim as NO_DRIFT",
  },
  {
    code: 1,
    name: "confirmed regression",
    meaning: "a gating metric cleared both nulls and reproduced on an independently collected arm",
    action:
      "investigate. Check provider identity and the corpus digest before assuming a model changed",
  },
  {
    code: 2,
    name: "misuse",
    meaning: "bad flags, an unreadable file, mismatched corpora, or a missing artifact",
    action: "fix the invocation. Nothing is known about the provider from this run",
  },
  {
    code: 3,
    name: "could not look",
    meaning:
      "the provider was unreachable, no credential was present, or a rate limit stopped the round",
    action: "this is an outage, not a regression. Retry, and do not record the round as quiet",
  },
];

export const describeExit = (code: ExitCode): ExitCodeMeaning =>
  EXIT_CODES.find((e) => e.code === code) ?? (EXIT_CODES[2] as ExitCodeMeaning);

/** Rendered under `--help` and at the foot of a text report, so the contract travels with the tool. */
export const EXIT_CODE_HELP: string = EXIT_CODES.map(
  (e) => `  ${e.code}  ${e.name}: ${e.meaning}`,
).join("\n");
