// Numbers in prose, regenerated from the artifacts they describe.
//
// A hand-maintained number is a claim that was true once, and the one that goes stale is always the
// one somebody quotes. This project already had four of them: a README that said "24 cases" after
// the corpus grew, a test count that moved every time a package gained a file, a freeze status
// duplicated in three documents, and a calibration summary that could only be refreshed by someone
// remembering to.
//
// So every such number lives between markers and is written by this script:
//
//     <!-- GENERATED:name -->   ... regenerated content ...   <!-- /GENERATED -->
//
// `--check` exits 1 when any block is stale, which is what makes the guarantee enforceable rather
// than aspirational. It is wired into CI and into `pnpm audit:release`.
//
// THAT SENTENCE WAS FALSE FOR A WHOLE RELEASE, which is worth leaving here as the argument for
// checking claims like it. `--check` was wired into neither: it ran only transitively inside
// `pnpm test`, where a stale-docs failure surfaces as a spec-package test failure. Of the three
// scripts in this directory with a `--check` mode, `write-manifest` and `case-composition` were
// gated and this one - the one written specifically to stop hand-maintained numbers going stale -
// was not. So the README went stale: 267 tests against 547, 9 mutants against 11, 11 scenarios
// against 13, all of them numbers this script can derive. The machine existed and was not plugged
// in.
//
// WHAT THIS DOES NOT COVER. Numbers in ordinary prose outside a block are still hand-typed and still
// go stale. The honest scope is: anything a script can derive belongs in a block, and anything that
// needs a sentence around it is a judgement that a human owns. `docs/CORPUS.md` carries its own
// block written by `case-composition.mjs`, which is left alone here rather than absorbed, because a
// composition table is a different derivation with a different owner.
//
// Usage: node scripts/generated-blocks.mjs [--check]

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CHECK = process.argv.includes("--check");

const read = (p) => readFileSync(join(ROOT, p), "utf8");
const readJson = (p) => JSON.parse(read(p));
const has = (p) => existsSync(join(ROOT, p));

// ---- the generators -------------------------------------------------------------------------------

/** Freeze status, from the freeze records themselves rather than from anybody's memory of them. */
function freezeStatus() {
  const rows = [];
  for (const split of readdirSync(join(ROOT, "corpus")).sort()) {
    const p = `corpus/${split}/FREEZE.json`;
    if (!has(p)) continue;
    const f = readJson(p);
    rows.push(
      `| \`${split}\` | ${f.caseCount} | ${f.frozenAt} | **${f.state}** | ${f.frozenAtCommit === null ? "none recorded" : `\`${String(f.frozenAtCommit).slice(0, 12)}\``} |`,
    );
  }
  const anyCashed = rows.some((r) => r.includes("**cashed**"));
  return [
    "| split | cases | frozen | ordering proof | commit |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    anyCashed
      ? "At least one split records a cashed ordering proof. `pnpm verify:freeze` should now exit 0 for it."
      : "**No split has a cashed ordering proof, and `pnpm verify:freeze` exits 1 by design.** It is not pending: it is PERMANENTLY UNAVAILABLE in this repository. The proof requires a commit at which `packages/detect/src/compare.ts` is absent, and that file exists in the first commit, so no commit that exists or ever will exist can satisfy it. `corpus/*/FREEZE.json` carries the recipe for the next repository, which is where it applies.\n\n`pnpm verify:precedence` checks a **weaker and genuinely cashable** claim instead: that each split was committed no later than every recorded run measured against it - so the corpus cannot have been adjusted to flatter a result it had already seen. That is a different sentence and is labelled as one.",
  ].join("\n");
}

/** Detector calibration, from results/calibration.json. Absent is reported as absent. */
function calibrationSummary() {
  if (!has("results/calibration.json")) {
    return "No calibration has been run in this checkout. `node scripts/calibrate.mjs` produces it, makes no provider call, and is reproducible from a seed.";
  }
  const c = readJson("results/calibration.json");
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const power = (c.powerCurve ?? []).find((p) => p.power >= 0.8);
  return [
    "| quantity | measured |",
    "|---|---|",
    `| corpus | \`${String(c.corpusDigest).slice(0, 16)}\`, ${c.cases} cases, ${c.replicates} replicates |`,
    `| A/A false positives | **${c.aa.drift} of ${c.aa.total}** = ${pct(c.aa.falsePositiveRate)} against a nominal 5.0% |`,
    `| live baseline vs candidate arm | \`${c.aa.liveVerdict}\` |`,
    `| first grid point at or above 80% power | ${power === undefined ? "not reached on the grid" : `${(power.achievedDrop * 100).toFixed(1)} points`} |`,
    `| predicted MDE | ${c.mde.predicted === null ? "not reached on the grid" : `${(c.mde.predicted * 100).toFixed(1)} points`} |`,
    `| prediction agrees with measurement | ${c.mde.agrees ? "yes" : "**NO**"} |`,
    `| rule of three at n=${c.replicates} | an all-passing case still permits a ${pct(c.mde.allPassCeiling)} failure rate |`,
    "",
    "Regenerated by `node scripts/calibrate.mjs`. Seeded, makes no provider call, exact on re-run.",
  ].join("\n");
}

/** The watcher protocol, summarised from the thresholds the code actually uses. */
function watcherProtocol() {
  const src = read("packages/detect/src/eprocess.ts");
  const healthy = /HEALTHY_MULTIPLE = (\d+)/.exec(src)?.[1] ?? "?";
  const threshold = /rebaselineEvidenceMultiple: (\d+)/.exec(src)?.[1] ?? "?";
  return [
    "| state | evidence multiple | what it means | action |",
    "|---|---|---|---|",
    `| \`healthy\` | under ${healthy}x | about as sensitive as a fresh watch | none |`,
    `| \`degraded\` | ${healthy}x to ${threshold}x | measurably slower to notice a real regression | plan a rotation |`,
    `| \`blind\` | ${threshold}x and above | a regression takes multiples longer to surface than anyone expects | \`sentinel baseline rotate\` |`,
    "",
    "`sentinel watch --status` reports the multiple, the ticks in this generation, the ticks across",
    "every generation, and the recommended action. **Spending sensitivity is never a regression and",
    "never sets a non-zero exit code.**",
  ].join("\n");
}

/** Remaining risks, derived from what is on disk rather than from a list somebody maintains. */
function remainingRisks() {
  const rows = [];
  const registry = read("packages/run/src/providers/index.ts");
  const unrun = [
    ...registry.matchAll(
      /id: "([a-z_]+)",\s*\n\s*credential: "([^"]+)",\s*\n\s*everRun: (true|false)/g,
    ),
  ]
    .filter((m) => m[3] === "false")
    .map((m) => m[1]);
  if (unrun.length > 0) {
    rows.push(
      `| BYOK adapters shipped and **unrun** | ${unrun.map((u) => `\`${u}\``).join(", ")} | OPEN. No credential exists in this environment; they are exercised against a fake transport only. |`,
    );
  }
  const anyCashed = readdirSync(join(ROOT, "corpus"))
    .filter((d) => has(`corpus/${d}/FREEZE.json`))
    .some((d) => readJson(`corpus/${d}/FREEZE.json`).state === "cashed");
  rows.push(
    `| Corpus ordering proof | \`verify:freeze\` | ${anyCashed ? "PARTIALLY CLOSED." : "OPEN, and PERMANENTLY so in this repository: the proof needs a commit at which packages/detect/src/compare.ts is absent, and it exists in the first commit. `pnpm verify:precedence` cashes a weaker, separately named claim instead."} |`,
  );
  rows.push(
    "| No real provider drift observed | the whole project | **OPEN, and the largest gap.** Every positive result is an injected perturbation or a deliberate model swap. The false-positive rate is measured; the true-positive rate in the wild is not. |",
  );
  rows.push(
    "| Watcher goes blind on a quiet stream | `evidenceMultiple` | MITIGATED, not fixed. It is a trade-off rather than a defect, is reported, and has a rotation protocol. |",
  );
  return ["| risk | where | status |", "|---|---|---|", ...rows].join("\n");
}

/**
 * The test count, from `results/tests.json`.
 *
 * A static count of `it(` does not work and is not a near miss: it gives 404 where the runner gives
 * 547, because several suites generate their cases in a loop. `scripts/test-counts.mjs` writes the
 * artifact and refuses to write one from a run that was not green, so a number here always means
 * "this many passed".
 */
function testCounts() {
  if (!has("results/tests.json")) {
    return "No test run has been recorded in this checkout. `pnpm test:count` produces it.";
  }
  const t = readJson("results/tests.json");
  const per = t.packages.map((p) => `${p.package} ${p.tests}`).join(", ");
  return [
    "| quantity | measured |",
    "|---|---|",
    `| tests, all green | **${t.totalTests}** across ${t.packages.length} packages |`,
    `| test files | ${t.totalFiles} |`,
    `| by package | ${per} |`,
    "",
    "Regenerated by `pnpm test:count`, which refuses to record a count from a run that was not green.",
  ].join("\n");
}

/**
 * The negative controls, from `results/discrimination.json`.
 *
 * The table this replaces said "9 of 9" against 11 mutants, omitted one entirely, and did not
 * record that `alwaysDrift` had started failing a scenario added after it was written. `mustFail` is
 * a floor rather than an exact set by design, so what a mutant ACTUALLY fails can only be found by
 * running it - which `scripts/discrimination.mjs` does, for free and with no provider call.
 */
function detectorControls() {
  if (!has("results/discrimination.json")) {
    return "No discrimination run has been recorded in this checkout. `pnpm controls` produces it.";
  }
  const d = readJson("results/discrimination.json");
  const rows = d.mutants.map(
    (m) =>
      `| \`${m.id}\` | ${m.mustFail.join(", ")} | ${m.actuallyFailed.join(", ")} | **${m.escapes.length}** |`,
  );
  return [
    `**${d.scenarios.length} calibration scenarios, ${d.mutants.length} detector mutants, ${d.totalEscapes} escapes.** The reference detector passes ${d.reference.passed} of ${d.reference.total}.`,
    "",
    "| mutant | declared `mustFail` | actually failed | escapes |",
    "|---|---|---|---|",
    ...rows,
    "",
    "`mustFail` is a FLOOR, not an exact set: these mistakes are not surgically isolated from one",
    "another, so a mutant may fail more scenarios than it names. What the list must never do is",
    "shrink. Regenerated by `pnpm controls`; seeded, deterministic, makes no provider call.",
  ].join("\n");
}

/**
 * Defect counts, from the headings in `docs/DEFECTS_FOUND.md`.
 *
 * Three documents carried three different totals - "Nine", "Eight" and "Ten" - for two lists that
 * are right there and countable.
 */
function defectCounts() {
  if (!has("docs/DEFECTS_FOUND.md")) return "docs/DEFECTS_FOUND.md is absent.";
  const text = read("docs/DEFECTS_FOUND.md");
  const rows = [];
  let total = 0;
  for (const section of text.split(/^## /m).slice(1)) {
    const version = section.split("\n", 1)[0].trim();
    if (!/^v\d/.test(version)) continue;
    // v0.2 uses `### n. Title`; v0.1 is carried forward as a numbered list.
    const headings = (section.match(/^### /gm) ?? []).length;
    const numbered = (section.match(/^\d+\. /gm) ?? []).length;
    const count = headings > 0 ? headings : numbered;
    total += count;
    rows.push(`| \`${version}\` | ${count} |`);
  }
  return [
    "| pass | defects found and fixed |",
    "|---|---|",
    ...rows,
    `| **total** | **${total}** |`,
    "",
    "Counted from the headings in [docs/DEFECTS_FOUND.md](docs/DEFECTS_FOUND.md).",
  ].join("\n");
}

/** The exit-code contract, from the one place that defines it. */
function exitCodes() {
  const src = read("packages/spec/src/exitCodes.ts");
  const rows = [];
  for (const m of src.matchAll(
    /\{\s*code:\s*(\d),\s*name:\s*"([^"]+)",\s*meaning:\s*\n?\s*"([^"]+)",\s*action:\s*\n?\s*"([^"]+)"/g,
  )) {
    rows.push(`| **${m[1]}** | ${m[2]} | ${m[3]} | ${m[4]} |`);
  }
  if (rows.length === 0) return "Could not read EXIT_CODES from packages/spec/src/exitCodes.ts.";
  return [
    "| code | name | meaning | what to do |",
    "|---|---|---|---|",
    ...rows,
    "",
    "From `EXIT_CODES` in `packages/spec/src/exitCodes.ts`, which is the only definition.",
  ].join("\n");
}

const BLOCKS = {
  "freeze-status": freezeStatus,
  "calibration-summary": calibrationSummary,
  "watcher-protocol": watcherProtocol,
  "remaining-risks": remainingRisks,
  "test-counts": testCounts,
  "detector-controls": detectorControls,
  "defect-counts": defectCounts,
  "exit-codes": exitCodes,
};

// ---- the rewriter ---------------------------------------------------------------------------------

const TARGETS = [
  "README.md",
  "RESULTS.md",
  "docs/DETECTOR_CARD.md",
  "docs/WATCHER.md",
  "docs/FREEZE.md",
];

let stale = 0;
let written = 0;
let found = 0;

for (const target of TARGETS) {
  if (!has(target)) continue;
  const before = read(target);
  let after = before;

  for (const [name, generate] of Object.entries(BLOCKS)) {
    const open = `<!-- GENERATED:${name} -->`;
    const close = "<!-- /GENERATED -->";
    const start = after.indexOf(open);
    if (start === -1) continue;
    const end = after.indexOf(close, start);
    if (end === -1) {
      console.error(`  UNCLOSED  ${target} has ${open} with no ${close}`);
      stale += 1;
      continue;
    }
    found += 1;
    const body = `${open}\n${generate()}\n`;
    after = after.slice(0, start) + body + after.slice(end);
  }

  if (after === before) continue;
  stale += 1;
  if (CHECK) {
    console.error(`  STALE     ${target}`);
    continue;
  }
  writeFileSync(join(ROOT, target), after);
  written += 1;
  console.log(`  written   ${target}`);
}

if (found === 0) {
  console.error(
    "no GENERATED blocks found. Either the markers were removed or the target list is wrong.",
  );
  process.exitCode = 1;
} else if (CHECK && stale > 0) {
  console.error("");
  console.error(`${stale} block(s) are out of date with the artifacts they describe.`);
  console.error(
    "Run `pnpm blocks:write`. If the underlying artifact is what changed, say so in RESULTS.md.",
  );
  process.exitCode = 1;
} else if (CHECK) {
  console.log(`all ${found} GENERATED block(s) are current`);
} else {
  console.log(`${found} block(s) checked, ${written} file(s) written`);
}
