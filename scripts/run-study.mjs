// Collect the measured runs this project's claims rest on.
//
// WHY IT ASKS FIRST. This spends real money on someone's account. A benchmark script that quietly
// bills a few dollars is a script people stop running, and a rung nobody reruns is a number that
// goes stale without anyone noticing. It prints an estimate from a measured pilot rate, and does
// nothing until `--yes`.
//
// WHAT IT COLLECTS, and why there are three arms rather than two:
//
//   baseline      the reference.
//   candidate     an independent draw against the SAME alias at the SAME time. This is an A/A pair
//                 by construction, so the correct verdict is no drift, and any drift it reports is
//                 a false positive that can be counted.
//   confirmation  a second independent candidate. Required before any finding may fail a build,
//                 because a threshold is crossed by noise on exactly the run where noise crosses it.
//
// A/A IS THE HEADLINE COLLECTION, NOT AN AFTERTHOUGHT. Most eval tooling demonstrates itself by
// showing a difference. The useful demonstration for a drift detector is the opposite: that it stays
// quiet when nothing changed, measured rather than asserted. The positive control against a
// genuinely different model is collected separately by `--positive-control`, and it is a deliberate
// model swap rather than provider drift, which the report says wherever it appears.
//
// Usage:
//   node scripts/run-study.mjs                      print the plan and the cost estimate
//   node scripts/run-study.mjs --yes                collect the A/A study
//   node scripts/run-study.mjs --yes --positive-control   also collect the cross-model arm
//   flags: --model <alias> --replicates <n> --split <v1|all|canary|extended|schema>
//          --concurrency <n>
//          `v1` is canary+extended, the 24-case pair the recorded runs were collected against and
//          the only set whose corpusDigest matches them. It is the default. `all` is all 34.
//          --out <dir>         where the arms are written. Defaults to results/runs for the v0.1
//                              pair and results/runs-v2 for any other split set, because a run
//                              over a different corpus is NOT comparable with the four already
//                              there and does not belong in the same directory.
//          --overwrite         permit writing over an existing arm. See the refusal below.
//
// IT REFUSES TO OVERWRITE A COLLECTED ARM. This is the guard that matters most in this file, and it
// was missing until a run over the schema split was planned and someone noticed that the command
// would have silently destroyed the study the whole repository rests on. `results/runs/` holds 960
// real calls that packages/spec/src/load.ts says cannot be recollected: they are a sample of one
// provider in one window, they cost real money, and re-collecting them would sample a DIFFERENT
// week of the thing under observation. There is no undo. So every target path is checked BEFORE the
// first call is made - not per-arm, because discovering the collision on arm three means arm one
// was already paid for and already lost.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

let spec;
let run;
try {
  spec = await import(join(ROOT, "packages/spec/dist/index.js"));
  run = await import(join(ROOT, "packages/run/dist/index.js"));
} catch (cause) {
  console.error("this script reads the built packages. Run `pnpm build` first.");
  console.error(String(cause));
  process.exit(2);
}

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 || at === process.argv.length - 1 ? fallback : process.argv[at + 1];
};
const has = (name) => process.argv.includes(`--${name}`);

const MODEL = arg("model", "sonnet");
const REPLICATES = Number(arg("replicates", "10"));
const SPLIT = arg("split", "v1");
const CONCURRENCY = Number(arg("concurrency", "6"));

// PER-ARCHETYPE COST, RE-DERIVED FROM THE COLLECTION RATHER THAN FROM THE PILOT.
//
// These were pilot guesses until the 960-call study existed to correct them, and the structured
// figure was wrong by a factor of three: guessed at $0.02 from a handful of pre-study calls,
// measured at $0.0067 across 30 of them. The consequence was not academic - the estimate printed
// for a 4-arm run over all 34 cases read $10.39 against a measured basis nearer $4.50, and an
// estimate that overstates by 2.3x is an estimate people learn to ignore, which defeats the point
// of asking before spending.
//
// Means over every non-errored sonnet record in results/runs/{baseline,candidate,confirmation},
// harness cost, warm prompt cache:
//
//   constrained_categorical   n=540   $0.001060
//   constrained_numeric       n= 60   $0.000827
//   free_form                 n= 60   $0.001569
//   structured_json           n= 30   $0.006717
//
// THE STRUCTURED FIGURE IS THE WEAK ONE and is the one that now dominates: v0.1 had 2 structured
// cases of 24, v0.2 has 12 of 34, so this rate sets most of the estimate for any run over the
// schema split while resting on the fewest observations. It is also sonnet-only; the haiku arm
// measured $0.00577 on the same cases while being three times dearer on the constrained ones,
// because the cheaper model answers at greater length.
//
// Used ONLY for the estimate printed before a run. The real figure comes from the run itself and is
// written into the snapshot, which is what the next revision of these constants should read.
//
// TWO TABLES, BECAUSE THE CONTROL ARM IS A DIFFERENT MODEL AND COSTS DIFFERENTLY. Applying the
// sonnet rates to all four arms is what made an earlier version of this fix UNDERSTATE a run, and
// understating a bill is the one direction a "do you want to spend this?" prompt must never err in.
// Haiku is priced at a fifth of sonnet per token and cost 2.7x more per call on this corpus,
// because it answers at length: 623 mean output tokens against sonnet's 60. A cost model that
// reads only the rate card is wrong by a factor of three here.
const MEASURED_USD = {
  sonnet: {
    constrained: 0.00106,
    constrained_numeric: 0.000827,
    free_form: 0.001569,
    structured: 0.006717,
  },
  // From the positive-control arm, n as above per archetype.
  control: {
    constrained: 0.003505,
    constrained_numeric: 0.002446,
    free_form: 0.002662,
    structured: 0.005774,
  },
};

// `both` still means the v0.1 PAIR, canary plus extended, and that is not an oversight left over
// from before the schema split existed. A run collected over those two splits carries the same
// corpusDigest as the four runs already in results/runs/, so it is comparable against them; a run
// that included the schema split would not be, and `compare` would answer NOT_COMPARABLE. Use
// `--split all` when collecting a fresh baseline that is meant to stand on its own.
// An unknown split name used to reach `loadSplit` and die inside `readdirSync` with an ENOENT
// naming a path the user never typed. A usage error is a different claim from a missing corpus and
// the two must not share an exit path.
const SPLIT_NAMES = ["v1", "all", "both", ...spec.ALL_SPLITS];
if (!SPLIT_NAMES.includes(SPLIT)) {
  console.error(`--split must be one of: ${SPLIT_NAMES.join(", ")}, not "${SPLIT}"`);
  process.exit(2);
}

// THE SAME VOCABULARY THE CLI USES. `both` used to mean canary+extended here and all three splits
// there, so the same flag on the same corpus produced two different digests depending on which
// entry point a person reached for. `v1` names the pair explicitly; `both` is now an alias for
// `all` in both places.
const splits =
  SPLIT === "v1"
    ? ["canary", "extended"]
    : SPLIT === "all" || SPLIT === "both"
      ? [...spec.ALL_SPLITS]
      : [SPLIT];
const cases = splits.flatMap((s) => spec.loadSplit(join(ROOT, "corpus", s), s));

// THE V0.1 PAIR IS THE ONLY SPLIT SET THAT BELONGS IN results/runs/. Anything else produces a
// different corpusDigest, which makes it NOT_COMPARABLE with the four arms already there, and a
// directory holding two mutually incomparable studies is a directory whose contents nobody can
// safely pass to `compare`. So the default output directory follows the corpus rather than the
// convenience of one path.
const isV1Pair = splits.length === 2 && splits[0] === "canary" && splits[1] === "extended";
const OUT = arg("out", undefined)
  ? resolve(ROOT, arg("out", undefined))
  : join(ROOT, "results", isV1Pair ? "runs" : "runs-v2");

const rateFor = (table, archetype) =>
  archetype === "structured_json"
    ? table.structured
    : archetype === "free_form"
      ? table.free_form
      : archetype === "constrained_numeric"
        ? table.constrained_numeric
        : table.constrained;

/** `arms` is the count collected at MODEL; the control arm, when present, is priced separately. */
const estimateFor = (list, arms, withControl) =>
  list.reduce((total, c) => {
    const main = rateFor(MEASURED_USD.sonnet, c.archetype) * REPLICATES * arms;
    const ctrl = withControl ? rateFor(MEASURED_USD.control, c.archetype) * REPLICATES : 0;
    return total + main + ctrl;
  }, 0);

const ARMS = has("positive-control") ? 4 : 3;
const LABELS = [
  "baseline",
  "candidate",
  "confirmation",
  ...(ARMS === 4 ? ["positive-control"] : []),
];
const calls = cases.length * REPLICATES * ARMS;
const estimate = estimateFor(cases, 3, has("positive-control"));

console.log(`corpus       ${cases.length} cases across ${splits.join(", ")}`);
console.log(`model        ${MODEL} (an alias, which is the point)`);
console.log(`replicates   ${REPLICATES} per arm`);
console.log(
  `arms         ${ARMS} (baseline, candidate, confirmation${ARMS === 4 ? ", positive control" : ""})`,
);
console.log(`calls        ${calls}`);
console.log(`estimate     $${estimate.toFixed(2)} at the rate measured by the 960-call study`);
console.log(`writing to   ${OUT.slice(ROOT.length + 1)}/`);
console.log("");

// EVERY TARGET IS CHECKED BEFORE THE FIRST CALL, and the check runs whether or not `--yes` was
// given, so the plan a person reads is the plan that will actually execute. Checking per-arm inside
// `collect` would be worse than useless: the collision on `confirmation` would be discovered after
// `baseline` had already been paid for and already overwritten.
const collisions = LABELS.map((label) => join(OUT, `${label}.json`)).filter((p) => existsSync(p));
if (collisions.length > 0 && !has("overwrite")) {
  console.error("REFUSING TO COLLECT: this run would write over arms that already exist.");
  console.error("");
  for (const p of collisions) console.error(`  ${p.slice(ROOT.length + 1)}`);
  console.error("");
  console.error(
    "A collected arm is a sample of one provider in one window, bought with real money",
  );
  console.error("and impossible to recollect: a second collection samples a DIFFERENT week of the");
  console.error("thing this project exists to observe. There is no undo.");
  console.error("");
  console.error("If you want a NEW study, send it somewhere else:");
  console.error("  --out results/runs-v2");
  console.error("If you genuinely mean to replace these, say so:");
  console.error("  --overwrite");
  process.exit(2);
}

if (!has("yes")) {
  console.log("re-run with --yes to spend it.");
  process.exit(0);
}

if (collisions.length > 0) {
  console.log(`--overwrite given: ${collisions.length} existing arm(s) will be replaced.`);
  console.log("");
}

mkdirSync(OUT, { recursive: true });

const collect = async (label, model) => {
  const provider = new run.ClaudeCliProvider(model);
  const started = Date.now();
  let last = 0;
  const snapshot = await run.runCorpus(provider, cases, splits, {
    replicates: REPLICATES,
    concurrency: CONCURRENCY,
    label,
    onProgress: (done, total) => {
      // Only when a person is watching. Piped into a file, a carriage return turns a progress
      // indicator into one long unreadable line, and this output ends up in RESULTS.md.
      if (!process.stdout.isTTY) return;
      const pct = Math.floor((done / total) * 20);
      if (pct === last) return;
      last = pct;
      process.stdout.write(`\r  ${label.padEnd(18)} ${done}/${total}`);
    },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  const path = join(OUT, `${label}.json`);
  writeFileSync(path, spec.canonicalJson(snapshot));
  const served =
    snapshot.fingerprint === null ? "(never observed)" : snapshot.fingerprint.resolvedModel;
  process.stdout.write(
    `${process.stdout.isTTY ? "\r" : ""}  ${label.padEnd(18)} ${snapshot.records.length} calls in ${seconds}s, ${snapshot.errorCount} errors, served ${served}, $${(snapshot.cost.harnessUsdPerCall * snapshot.records.length).toFixed(4)}\n`,
  );
  return snapshot;
};

// Sequential, not parallel. The three arms must be INDEPENDENT collections, and running them at the
// same moment against the same provider would correlate exactly the load-dependent behaviour the
// confirmation arm exists to rule out.
await collect("baseline", MODEL);
await collect("candidate", MODEL);
await collect("confirmation", MODEL);
if (has("positive-control")) {
  // A DELIBERATE MODEL SWAP IS NOT PROVIDER DRIFT, and the report says so wherever this appears. It
  // is a positive control with a genuinely different model on the other side, used only to show the
  // pipeline confirms a real difference end to end rather than only on synthetic perturbations.
  await collect("positive-control", arg("control-model", "haiku"));
}

console.log("");
console.log(`written to ${OUT.slice(ROOT.length + 1)}/`);
console.log("next: node scripts/calibrate.mjs");
