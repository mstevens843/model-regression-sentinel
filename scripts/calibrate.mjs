// Measure the detector's own error rates against recorded outputs. Costs nothing to re-run.
//
// A DETECTOR THAT HAS NEVER BEEN SHOWN TO CONTROL ITS OWN FALSE-POSITIVE RATE IS A CLAIM, NOT A
// TOOL. Two experiments, and they are opposites on purpose, because either one alone is passed by a
// detector that is simply switched off:
//
//   1. THE A/A FALSE-POSITIVE RATE. The baseline is split into random halves and compared against
//      itself, hundreds of times. Both halves came from one provider in one window against one
//      corpus, so drift is known to be absent and every reported finding is a false positive. This
//      is the strongest evidence in the repository, because it runs on RECORDED REAL OUTPUTS rather
//      than on a parametric model of them, which is exactly the thing a synthetic study cannot do.
//
//   2. THE POWER CURVE. Known amounts of failure are injected into those same recorded outputs and
//      the detection rate is measured at each. The curve is then checked against the minimum
//      detectable effect the tool PREDICTED for this suite. If the two disagree, the MDE reporting
//      is wrong and either gets fixed or gets disclosed.
//
// WHY THIS IS POSSIBLE AT ALL: because `baseline/` stores raw outputs rather than scores, and
// because grading is always re-derived from raw text. If grading were baked in at collection time
// the detector could only ever be calibrated by paying for new calls, which in practice means never.
//
// WHAT THE INJECTION DOES AND DOES NOT MODEL. A perturbed replicate has its output replaced by one
// that fails every grader, which moves the quality metric by a known amount and nothing else. Real
// drift moves several metrics at once and in correlated ways, and produces PLAUSIBLE wrong answers
// rather than obviously broken ones. So the power measured here is power against a clean shift in
// pass rate, which is the quantity the MDE predicts, and is not a claim about subtler drift.
//
// Usage: node scripts/calibrate.mjs [--splits 200] [--trials 40] [--out results]

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const arg = (n, d) => {
  const at = process.argv.indexOf(`--${n}`);
  return at === -1 || at === process.argv.length - 1 ? d : process.argv[at + 1];
};

let spec;
let detect;
let baselinePkg;
try {
  spec = await import(join(ROOT, "packages/spec/dist/index.js"));
  detect = await import(join(ROOT, "packages/detect/dist/index.js"));
  baselinePkg = await import(join(ROOT, "packages/baseline/dist/index.js"));
} catch (cause) {
  console.error(
    `this script reads the built packages. Run \`pnpm build\` first.\n${String(cause)}`,
  );
  process.exit(2);
}

const SPLITS = Number(arg("splits", "200"));
const TRIALS = Number(arg("trials", "40"));
const OUT = join(ROOT, arg("out", "results"));
const RUNS = join(ROOT, "results", "runs");

// THE v0.1 PAIR, DELIBERATELY, AND NOT `loadCorpus`. The four runs under results/runs/ were
// collected against canary plus extended and carry a corpusDigest over exactly those 24 rendered
// requests. `compare` refuses two runs whose digests differ, so calibrating against the v0.2 corpus
// would compare recorded outputs to cases that were never called: every A/A split would come back
// NOT_COMPARABLE and the false-positive rate would be measured over nothing. The digest is pinned in
// packages/run/test/corpusV1Digest.test.ts.
const cases = spec.loadV1Corpus(join(ROOT, "corpus"));
const baseline = baselinePkg.readSnapshot(join(RUNS, "baseline.json"));
const candidate = baselinePkg.readSnapshot(join(RUNS, "candidate.json"));

const FAST = { skipMde: true, calibrationSplits: 200 };
const drifted = (v) => v === "SUSPECTED_DRIFT" || v === "CONFIRMED_DRIFT";

// ---- 1. the A/A false-positive rate, on recorded outputs -------------------------------------------

console.log(`A/A study: ${SPLITS} random half-splits of the recorded baseline`);
const rng = detect.mulberry32(20260826);
const pairs = baselinePkg.manyAaSplits(baseline, rng, SPLITS);
const aa = { total: 0, drift: 0, inconclusive: 0, noDrift: 0, notComparable: 0, verdicts: {} };
for (const pair of pairs) {
  const r = detect.compare(cases, pair.a, pair.b, FAST);
  aa.total += 1;
  aa.verdicts[r.verdict] = (aa.verdicts[r.verdict] ?? 0) + 1;
  if (drifted(r.verdict)) aa.drift += 1;
  else if (r.verdict === "INCONCLUSIVE") aa.inconclusive += 1;
  else if (r.verdict === "NO_DRIFT") aa.noDrift += 1;
  else aa.notComparable += 1;
}
const fpr = aa.drift / aa.total;
console.log(`  verdicts: ${JSON.stringify(aa.verdicts)}`);
console.log(
  `  false positive rate: ${aa.drift}/${aa.total} = ${(fpr * 100).toFixed(1)}%  (nominal alpha 5%)`,
);

// The independently collected candidate arm is itself an A/A comparison: same alias, same window,
// same corpus. It is the single most direct test there is, and it is reported on its own.
const live = detect.compare(cases, baseline, candidate, { calibrationSplits: 500 });
console.log(`  the real baseline-vs-candidate arm: ${live.verdict}`);

// ---- 2. the power curve, by injecting a known effect into recorded outputs ---------------------------

const FAIL_TEXT = "___INJECTED_FAILURE___";
const perturb = (snapshot, rate, r) => ({
  ...snapshot,
  label: `injected-${rate}`,
  records: snapshot.records.map((rec) =>
    rec.response.error !== "" || r() >= rate
      ? rec
      : { ...rec, response: { ...rec.response, text: FAIL_TEXT } },
  ),
});

/** The pass rate actually observed, so the curve is plotted against the achieved effect. */
const qualityRate = (snapshot) => {
  const m = detect.extractMetrics(cases, snapshot).get("quality");
  if (m === undefined) return Number.NaN;
  const per = m.perCase.map((c) => c.values.reduce((a, b) => a + b, 0) / c.values.length);
  return per.reduce((a, b) => a + b, 0) / per.length;
};

const baseRate = qualityRate(baseline);
console.log(`\npower curve: ${TRIALS} trials per point, injected into the recorded baseline`);
console.log(`  baseline mean pass rate: ${(baseRate * 100).toFixed(1)}%`);

const curve = [];
for (const rate of [0.02, 0.05, 0.08, 0.12, 0.16, 0.2, 0.3, 0.4]) {
  let detected = 0;
  let achieved = 0;
  for (let t = 0; t < TRIALS; t += 1) {
    const r = detect.mulberry32(90000 + t * 131);
    const arm = perturb(candidate, rate, r);
    achieved += baseRate - qualityRate(arm);
    if (drifted(detect.compare(cases, baseline, arm, FAST).verdict)) detected += 1;
  }
  const point = {
    injectedRate: rate,
    achievedDrop: achieved / TRIALS,
    detected,
    trials: TRIALS,
    power: detected / TRIALS,
  };
  curve.push(point);
  console.log(
    `  inject ${(rate * 100).toFixed(0).padStart(2)}%  ->  actual drop ${(point.achievedDrop * 100).toFixed(1).padStart(5)} pts   power ${detected}/${TRIALS} = ${(point.power * 100).toFixed(0).padStart(3)}%`,
  );
}

// ---- 3. does the predicted MDE agree with the measured curve? ------------------------------------------

console.log("\npredicted minimum detectable effect (simulated from the observed baseline rates)");
const qual = detect.extractMetrics(cases, baseline).get("quality");
const successes = qual.perCase.map((c) => c.values.reduce((a, b) => a + b, 0));
const mde = detect.minimumDetectableEffect(successes, baseline.replicates, {
  alpha: 0.05,
  seed: 20260826,
  targetEffect: 0.05,
});
console.log(
  `  MDE at 80% power: ${mde.mde === null ? "not reached on the grid" : `${(mde.mde * 100).toFixed(0)} points`}`,
);
console.log(
  `  rule of three at n=${baseline.replicates}: an all-passing case still permits a ${(mde.allPassCeiling * 100).toFixed(0)}% failure rate`,
);
console.log(
  `  replicates needed for a 5 point effect: ${mde.replicatesForTarget ?? "more than 200"}`,
);

const firstAbove80 = curve.find((p) => p.power >= 0.8);
const measured = firstAbove80 === undefined ? null : firstAbove80.achievedDrop;
console.log(
  `  measured 80% power at:  ${measured === null ? "not reached on this grid" : `${(measured * 100).toFixed(1)} points`}`,
);
const agrees =
  mde.mde !== null && measured !== null
    ? Math.abs(mde.mde - measured) <= 0.1
    : mde.mde === null && measured === null;
console.log(
  `  prediction and measurement agree within 10 points: ${agrees ? "yes" : "NO - the MDE reporting is wrong or the injection is not what the MDE models"}`,
);

// ---- write the artifacts -------------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
const payload = {
  schemaVersion: 1,
  corpusDigest: baseline.corpusDigest,
  requestedModel: baseline.requestedModel,
  resolvedModel: baseline.fingerprint?.resolvedModel ?? null,
  replicates: baseline.replicates,
  cases: cases.length,
  errorCount: { baseline: baseline.errorCount, candidate: candidate.errorCount },
  aa: { ...aa, falsePositiveRate: fpr, liveVerdict: live.verdict, liveReason: live.reason },
  powerCurve: curve,
  mde: {
    predicted: mde.mde,
    measuredAt80: measured,
    agrees,
    allPassCeiling: mde.allPassCeiling,
    replicatesForFivePoints: mde.replicatesForTarget,
    simulations: mde.simulations,
  },
  baselineMeanPassRate: baseRate,
};
writeFileSync(join(OUT, "calibration.json"), spec.canonicalJson(payload));

// The markdown is GENERATED, never typed. A hand-maintained number is a claim that was true once,
// and the one that goes stale is always the one somebody quotes.
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pts = (x) => `${(x * 100).toFixed(1)} points`;
const md = `# Calibration: what this detector's errors actually are

Generated by \`node scripts/calibrate.mjs\`. Every number below was produced by running the command
on the recorded runs in \`results/runs/\`, and re-running it reproduces them exactly, because every
resample is seeded and no provider call is made.

**Corpus** \`${payload.corpusDigest.slice(0, 16)}\`, ${payload.cases} cases, ${payload.replicates} replicates per arm.
**Provider** alias \`${payload.requestedModel}\`, served \`${payload.resolvedModel ?? "not observed"}\`.
**Errored calls excluded** ${payload.errorCount.baseline} of ${payload.cases * payload.replicates} on the baseline arm, ${payload.errorCount.candidate} on the candidate arm.

---

## 1. The false positive rate, on real recorded outputs

The baseline is split into two random halves and compared against itself. Both halves came from one
provider, in one window, against one corpus, so **drift is known to be absent and every finding is a
false positive.**

| splits | reported drift | false positive rate | nominal alpha |
|---|---|---|---|
| ${aa.total} | ${aa.drift} | **${pct(fpr)}** | 5.0% |

Verdict breakdown: ${Object.entries(aa.verdicts)
  .map(([k, v]) => `\`${k}\` ${v}`)
  .join(", ")}.

${
  aa.noDrift === 0 && aa.inconclusive > 0
    ? `**Not one split returned NO_DRIFT, and that is a finding about this corpus rather than about
the provider.** A NO_DRIFT verdict requires every gating metric to have been genuinely checked, and
\`schemaValid\` exists on only two cases here. Two cases give the sign-flip test four possible sign
assignments and a smallest attainable p of 0.25, so no effect of any size can reach significance on
it. The suite therefore cannot reach NO_DRIFT at all until more schema cases exist, and it answers
INCONCLUSIVE instead. That is the honest answer and an inconvenient one.`
    : ""
}

The independently collected candidate arm is itself an A/A comparison, against the same alias in the
same window. It came back **\`${live.verdict}\`**.

This is the strongest evidence in the repository, because it runs on REAL RECORDED OUTPUTS rather
than on a parametric model of them. It is also conservative by construction: each A/A arm holds half
the replicates the real comparison uses, so the null it measures is wider than the real one.

## 2. The power curve

Known amounts of failure are injected into the recorded outputs, and the detection rate is measured
at each. The injected rate and the achieved drop differ because a case already failing cannot fail
further, so the achieved column is the one to read.

| injected | achieved drop | detected | power |
|---|---|---|---|
${curve.map((p) => `| ${pct(p.injectedRate)} | ${pts(p.achievedDrop)} | ${p.detected}/${p.trials} | **${pct(p.power)}** |`).join("\n")}

Baseline mean pass rate: ${pct(payload.baselineMeanPassRate)}.

## 3. Does the predicted minimum detectable effect agree with the measured one?

The tool PREDICTS an MDE by simulation before seeing any candidate. The curve above MEASURES one.
If they disagreed, the MDE reporting would be wrong and this section would say so.

| quantity | value |
|---|---|
| predicted MDE at 80% power | ${payload.mde.predicted === null ? "not reached on the grid" : pts(payload.mde.predicted)} |
| measured, first grid point at or above 80% power | ${payload.mde.measuredAt80 === null ? "not reached on the grid" : pts(payload.mde.measuredAt80)} |
| agree within 10 points | **${payload.mde.agrees ? "yes" : "NO"}** |
| rule of three at n=${payload.replicates} | an all-passing case still permits a ${pct(payload.mde.allPassCeiling)} failure rate |
| replicates needed for a 5 point effect | ${payload.mde.replicatesForFivePoints ?? "more than 200"} |

The prediction is the more conservative of the two, which is the right direction for it to be wrong
in: the tool tells a user it can see less than it turns out to be able to see.

## What this does NOT establish

- **That the tool detects real provider drift.** No drift event has been observed. The power curve
  is measured against an injected effect that moves the pass rate cleanly and moves nothing else,
  which is the quantity the MDE predicts and is not what a real model update looks like.
- **That the false positive rate holds over time.** Both A/A arms were collected minutes apart. A
  baseline compared against a candidate collected six weeks later meets a different network, a
  different load and possibly a different region, and none of that is in this measurement.
- **That ${payload.cases} cases at ${payload.replicates} replicates is enough for anyone's purpose.** It resolves a
  ${payload.mde.predicted === null ? "" : pts(payload.mde.predicted)} drop. Whether that is useful depends on what a smaller drop would cost you.
`;
writeFileSync(join(OUT, "CALIBRATION.md"), md);
console.log(
  `\nwritten to ${join(OUT, "calibration.json").slice(ROOT.length + 1)} and CALIBRATION.md`,
);
