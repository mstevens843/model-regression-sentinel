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
//   flags: --model <alias> --replicates <n> --split <canary|extended|schema|both|all>
//          --concurrency <n>   (`both` is the v0.1 pair and stays comparable with results/runs/)

import { mkdirSync, writeFileSync } from "node:fs";
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
const SPLIT = arg("split", "both");
const CONCURRENCY = Number(arg("concurrency", "6"));
const OUT = join(ROOT, "results", "runs");

// Measured on this machine on 2026-08-26, warm prompt cache, with the stripped argv the provider
// uses. Constrained cases came in at $0.00084; the reasoning-heavy structured cases ran 857 to 1656
// output tokens and cost roughly $0.02. Used only for the estimate printed before a run; the real
// figure comes from the run itself and is written into the snapshot.
const PILOT_USD = { constrained: 0.00084, free_form: 0.0015, structured: 0.02 };

// `both` still means the v0.1 PAIR, canary plus extended, and that is not an oversight left over
// from before the schema split existed. A run collected over those two splits carries the same
// corpusDigest as the four runs already in results/runs/, so it is comparable against them; a run
// that included the schema split would not be, and `compare` would answer NOT_COMPARABLE. Use
// `--split all` when collecting a fresh baseline that is meant to stand on its own.
const splits =
  SPLIT === "both" ? ["canary", "extended"] : SPLIT === "all" ? [...spec.ALL_SPLITS] : [SPLIT];
const cases = splits.flatMap((s) => spec.loadSplit(join(ROOT, "corpus", s), s));

const estimateFor = (list, arms) =>
  list.reduce((total, c) => {
    const rate =
      c.archetype === "structured_json"
        ? PILOT_USD.structured
        : c.archetype === "free_form"
          ? PILOT_USD.free_form
          : PILOT_USD.constrained;
    return total + rate * REPLICATES * arms;
  }, 0);

const ARMS = has("positive-control") ? 4 : 3;
const calls = cases.length * REPLICATES * ARMS;
const estimate = estimateFor(cases, ARMS);

console.log(`corpus       ${cases.length} cases across ${splits.join(", ")}`);
console.log(`model        ${MODEL} (an alias, which is the point)`);
console.log(`replicates   ${REPLICATES} per arm`);
console.log(
  `arms         ${ARMS} (baseline, candidate, confirmation${ARMS === 4 ? ", positive control" : ""})`,
);
console.log(`calls        ${calls}`);
console.log(`estimate     $${estimate.toFixed(2)} at the pilot rate measured on this machine`);
console.log("");

if (!has("yes")) {
  console.log("re-run with --yes to spend it.");
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });

const collect = async (label, model) => {
  const provider = new run.ClaudeCliProvider(model);
  const started = Date.now();
  let last = 0;
  const snapshot = await run.runCorpus(
    provider,
    cases,
    splits.length === 1 ? splits[0] : "extended",
    {
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
    },
  );
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
