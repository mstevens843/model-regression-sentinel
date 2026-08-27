# Results

Verification record for the first pass. Every number here was produced by running the command shown,
on the machine and toolchain named below, and reading its output. Nothing is copied from a build log,
an earlier run, or a summary of a run. Where something is skipped, weaker than it looks, or unproven,
it says so and says why.

**Frozen:** 2026-08-26
**Toolchain:** Node v22.22.1, pnpm 10.33.0, TypeScript 5.9.3, vitest 2.1.9, tsup 8.5.1, biome 1.9.4
**Provider:** the locally authenticated `claude` CLI, version 2.1.246. **No API key exists in this
environment**, so both BYOK HTTP providers are shipped and unrun.
**Corpus:** 24 cases, digest `7da85be79eb7870d...`, frozen by `corpus/*/MANIFEST.sha256`.

---

## v0.2, a hardening pass

No new provider calls. The four recorded runs and the 960 calls behind them are byte-identical to
v0.1, and `corpusDigestOf(loadV1Corpus(...))` still equals the digest recorded inside them. That
mattered: expanding the corpus would otherwise have stranded the only real measured evidence this
project has, and it cannot be recollected without spending again.

| | v0.1 | v0.2 |
|---|---|---|
| tests | 267 | **547 at the v0.2 cut**, and generated from `results/tests.json` thereafter rather than typed here - see the current figure above |
| detector mutants | 9 | **10** |
| calibration scenarios | 11 | **12** |
| frozen cases | 24 | **34**, across three splits |
| generated blocks | 0 | **6**, plus the composition table |
| exit codes | 3 | **4**, splitting misuse from could-not-look |
| real provider calls | 960 | **960**, unchanged |

**What changed, in one line each.**

- **The watcher is honest about its own dullness.** `sentinel watch --status` reports how much more
  evidence it now needs than a fresh watch, and `sentinel baseline rotate` is the only route to
  clearing that, requiring a newly collected artifact and refusing four ways. `watch --init` refuses
  to overwrite an existing watch, because deleting a state file was a silent reset.
- **Provider metadata drift is a separate category from quality drift.** Two absences no longer
  compare as an agreement.
- **`NO_DRIFT` is structurally reachable.** `schemaValid` went from 2 cases to 12; at k=2 the
  sign-flip test's smallest attainable two-sided p is 0.5 - 2/2^k, not 1/2^k, because the
  observed assignment and its mirror are both always at least as extreme - so no effect of any
  size could ever resolve.
  Whether it is reachable against a real provider is a question about data, and answering it needs a
  collection this pass did not authorise.
- **Release verification cannot mislead a stranger.** A bare `sentinel release verify` defaults to
  `dist/release` and refuses rather than scanning `.`, because a verifier pointed at the wrong place
  reports every artifact of a complete release as absent, which reads as a broken release.
- **`pnpm release` now refuses to publish.** The machine that built this has an authenticated
  `~/.npmrc` and all seven names are unclaimed, so the manifest no longer carries a command that
  could publish seven README-less packages by autocomplete.

**Eight defects found and fixed**, listed with their consequences in
[docs/DEFECTS_FOUND.md](docs/DEFECTS_FOUND.md). The one worth reading is the third recurrence of a
NaN reaching canonical JSON: `calibratedP` and `noiseFloor95` were NaN whenever the baseline was too
thin to calibrate, so `compare --format json` threw on any run with fewer than four replicates,
which is exactly the underpowered run a user is most likely to be inspecting. Found by an
adversarial sweep, not by reading. The rule is now written down and swept:
**anything crossing a serialization boundary must be finite or null.**

## Summary

**READ THE TWO HALVES SEPARATELY.** This document mixes two kinds of claim, and an earlier version
did not say so - it opened with a v0.2 changelog and then presented v0.1 numbers as current, which
is the root of most of what a reader gets wrong here.

- **Current capability** is what the code does today. Re-runnable on any checkout, free, no provider
  call. Every count is generated from the artifact it describes.
- **Recorded evidence** is the 960 paid calls from 2026-08-26, against the **24-case v0.1 corpus**.
  It cannot be re-run without spending again, and it would sample a different week of the thing
  under observation if it were. The v0.2 corpus has 34 cases and **no evidence has been collected
  against it.**

### Current capability, re-runnable now

| Gate | Result |
|---|---|
| lint, typecheck, build | pass, 7 packages, 14 typecheck tasks |
| tests | generated below; `pnpm test:count` |
| the frozen corpus validates and matches its manifest | pass, **34 cases across 3 splits** |
| `shasum -a 256 -c` agrees, with no code from this project | pass, 9 files, one manifest per split |
| every generated block matches its artifact | `pnpm blocks:check`, gated in CI and `audit:release` |
| the freeze ordering proof | **exits 1 by design.** UNAVAILABLE, and permanently so here |
| `pnpm audit:release`, including two negative controls that must fire | all green |
| calibration scenarios and detector mutants | generated below; `pnpm controls` |

<!-- GENERATED:test-counts -->
| quantity | measured |
|---|---|
| tests, all green | **579** across 7 packages |
| test files | 152 |
| by package | cli 163, spec 115, detect 77, run 75, report 57, watch 56, baseline 36 |

Regenerated by `pnpm test:count`, which refuses to record a count from a run that was not green.
<!-- /GENERATED -->

### Recorded evidence, v0.1 corpus, 2026-08-26

| Gate | Result |
|---|---|
| real provider calls | **960** across four arms, **$1.77** |
| corpus they were collected against | 24 cases, digest `7da85be7...` |
| A/A false positive rate on real recorded outputs | **0 of 200** |
| power at a 7.0 point drop | **93%** |
| predicted MDE agrees with the measured one | yes, conservatively |
| `NO_DRIFT` ever observed on THIS corpus | **no**, and it never can be: `schemaValid` sits on 2 cases here, where the two-sided sign-flip floor is 0.5. Observed on the 34-case v0.2 collection instead - see the v0.3 section above. |
| the tool has ever observed real provider drift | **no** |

---

## v0.3: the collection the schema split was added for

`node scripts/run-study.mjs --split all --replicates 10 --concurrency 6 --positive-control --yes`

**The first `NO_DRIFT` verdict this project has ever produced on real provider outputs.** Two
independently collected arms against the same pinned alias, 34 cases, and every gating metric
resolved a minimum detectable effect:

| metric | smallest uniform drop resolvable |
|---|---|
| `quality` | 10.0 pp |
| `schemaValid` | 25.0 pp - **resolvable at all for the first time**, which is what the schema split was added to make possible |
| `refusal` | 8.0 pp - resolvable at all for the first time, after the direction defect below |
| `outputTokens` | 15.0% |

It took two things and only one of them was the corpus. `schemaValid` needed the 12-case split. But
`refusal` was blocked by a defect: the power simulator searched a DROP in it, and on a healthy
corpus the refusal rate is 0, so there was nothing to drop and its MDE never resolved on ANY corpus.
Collecting more data would never have fixed it. Both had to be right before the verdict was
reachable.

### The arms

| arm | calls | errors | served identity | measured cost |
|---|---|---|---|---|
| baseline | 340 | 47 | `claude-sonnet-5` | $0.7284 |
| candidate | 340 | 53 | `claude-sonnet-5` | $0.6339 |
| confirmation | 340 | 59 | `claude-sonnet-5` | $0.6075 |
| positive control | 340 | 15 | **`claude-haiku-4-5-20251001`** | $1.4724 |
| **total** | **1360** | **174** | | **$3.4423** |

Estimated at $4.56 beforehand from the per-archetype rates the v0.1 study measured, so the estimate
was 33 percent high - conservative, which is the right direction for a prompt that asks someone to
spend money.

**THE SONNET ERROR RATE QUADRUPLED, AND IT IS THE SCHEMA SPLIT.** 159 of 1020 sonnet calls errored
here (15.6%) against 30 of 720 (4.2%) in v0.1. The composition explains it: `structured_json` went
from 2 cases of 24 to 12 of 34, and that archetype carried every error in the v0.1 collection too.
Haiku errored on 15 of 340. This is a fact about the archetype and this harness, not a drift signal,
and it is recorded because a rising error rate WOULD be a signal and the baseline for judging one
has now moved.

### The verdicts

| comparison | verdict | exit |
|---|---|---|
| baseline vs candidate, confirmed | **`NO_DRIFT`** | 0 |
| baseline vs the haiku arm, confirmed | `CONFIRMED_DRIFT` on `outputTokens` | 1 |

The second is a deliberate model swap and is **not** provider drift. What it shows is that the
pipeline still attributes correctly on a corpus a third larger: output tokens moved and reproduced,
and six fingerprint fields moved with no p-value attached to any of them.

### The A/A calibration on this corpus

`node scripts/calibrate.mjs --runs results/runs-v2`, recorded in
[results/CALIBRATION-V2.md](results/CALIBRATION-V2.md).

| quantity | v0.1 corpus | v0.2 corpus |
|---|---|---|
| A/A false positives | 0 of 200 | **1 of 200 = 0.5%** against a nominal 5% |
| baseline mean pass rate | 87.5% | 89.7% |
| predicted MDE | 10.0 points | 8.0 points |
| measured 80% power at | 7.0 points | 9.7 points |
| prediction direction | conservative | **optimistic, which is the wrong direction** |

**The last row is the one to read, and the document says so itself now.** On the v0.1 study the
predicted MDE was more conservative than the measured one, and the generated record said so - as an
UNCONDITIONAL sentence, which would have kept saying it whichever way the numbers fell. It is now
computed, and on the very first new study it fired: the tool predicts it can resolve 8 points and
measurably resolves 9.7, so it is overstating its own sensitivity by about 1.7 points. That is worth
investigating and it is not hidden.

---

## The v0.1 collection

`node scripts/run-study.mjs --replicates 10 --concurrency 6 --positive-control --yes`

| arm | calls | errors | served identity | measured cost |
|---|---|---|---|---|
| baseline | 240 | 10 | `claude-sonnet-5` | $0.3101 |
| candidate | 240 | 10 | `claude-sonnet-5` | $0.3060 |
| confirmation | 240 | 10 | `claude-sonnet-5` | $0.3015 |
| positive control | 240 | 0 | **`claude-haiku-4-5-20251001`** | $0.8486 |
| **total** | **960** | 30 | | **$1.7662** |

Estimated beforehand at $2.39 from a measured pilot rate, so the estimate was 35 percent high.

**Three findings from the collection itself, none of them planned.**

**The alias resolution behaves exactly as the wedge predicts.** `sonnet` served `claude-sonnet-5`
with no date. `haiku` served `claude-haiku-4-5-20251001`, a dated snapshot, and reported a context
window of 200,000 against sonnet's 1,000,000 and a max output of 32,000 against 64,000. Six
fingerprint fields moved between the two, with no p-value attached to any of them.

**The cheaper model cost 2.7 times more.** Haiku is priced at a fifth of sonnet per token and its
arm cost $0.8486 against $0.3101, because it answered with a mean of 623 output tokens where sonnet
used 60. A cost comparison between models that reads only the rate card is wrong by a factor of
three here, which is why cost is reported as two bounds and is not a gating metric.

**Structured output failed 4 percent of the time, and only on sonnet.** All 30 errors were `exit 1`
from the CLI on the two `structured_json` cases, 10 per sonnet arm and 0 on the haiku arm. Errored
calls are dropped from every sample and counted separately, because a provider error is not a
quality regression. A rising error rate would itself be a drift signal and is reported as its own
column.

## Compare, end to end, on the collected runs

```
node packages/cli/dist/cli.js compare --baseline results/runs/baseline.json \
    --candidate results/runs/candidate.json --confirm results/runs/confirmation.json
```

| comparison | verdict | exit | what moved |
|---|---|---|---|
| baseline vs candidate, same alias, same window | `INCONCLUSIVE` | 0 | quality 87.5% to 87.5%, effect -0.0 pp |
| baseline vs an injected regression on the recorded outputs | `CONFIRMED_DRIFT` | 1 | quality 87.5% to 57.7%, -29.8 pp, reproduced |
| baseline vs the haiku arm | `CONFIRMED_DRIFT` | 1 | outputTokens +174.6%, reproduced |
| two runs of different corpora | `NOT_COMPARABLE` | 2 | refused rather than diffed |

**The first row is the result that matters.** Two independent collections against the same alias
minutes apart produced no finding, and the tool said so and returned zero.

**The third row is a deliberate model swap and is NOT provider drift.** It is a positive control
with a genuinely different model on the other side. What it shows is that the pipeline confirms a
real difference end to end and attributes it correctly: **quality moved only 6.3 points and did not
clear either null, while output tokens moved 174.6 percent and did.** Haiku was nearly as accurate
on this corpus and far more verbose, and the detector said exactly that rather than reporting a
single undifferentiated regression.

### The noise floor this provider actually has

Measured from A/A splits of the baseline, in the same units as each effect:

| metric | 95th percentile of the provider's own A/A wobble |
|---|---|
| quality | 3.3 percentage points |
| outputTokens | 6.7% |
| latencyMs | 6.9% |
| costUsd | 4.7% |

## Calibration: the detector's own error rates

`node scripts/calibrate.mjs --splits 200 --trials 40`, full record in
[results/CALIBRATION.md](results/CALIBRATION.md). Free to re-run: it makes no provider call.

**False positives: 0 of 200** A/A splits of the recorded baseline, against a nominal alpha of 5
percent. Conservative, as designed, since each A/A arm holds half the replicates the real comparison
uses.

**Power, injected into the recorded outputs:**

| achieved drop | detected | power |
|---|---|---|
| 1.8 points | 0/40 | 0% |
| 4.5 points | 22/40 | 55% |
| 7.0 points | 37/40 | **93%** |
| 10.4 points and above | 40/40 | 100% |

**The predicted MDE was 10 points and the measured one 7.0 points.** The prediction is the more
conservative of the two, which is the right direction for it to be wrong in: the tool tells a user
it can see less than it turns out to be able to see.

## Mutant discrimination

`pnpm controls`, which runs every mutant against every scenario and writes
`results/discrimination.json`. The table below is generated from that file.

THIS TABLE USED TO BE MAINTAINED BY HAND, and it is the best example in the repository of why that
does not work. It said "9 of 9" while eleven mutants existed, omitted `metadataIsRegression`
entirely, and did not record that `alwaysDrift` had begun failing a scenario added after the table
was written. Every one of those was true when typed.

<!-- GENERATED:detector-controls -->
**13 calibration scenarios, 11 detector mutants, 0 escapes.** The reference detector passes 13 of 13.

| mutant | declared `mustFail` | actually failed | escapes |
|---|---|---|---|
| `rawDiff` | 01, 03, 04 | 01, 03, 04, 07, 09, 10, 13 | **0** |
| `alwaysQuiet` | 02, 06, 09 | 02, 06, 09 | **0** |
| `alwaysDrift` | 01, 03, 04, 07, 08 | 01, 03, 04, 05, 07, 08, 09, 10, 12 | **0** |
| `meanLatencyGate` | 04 | 01, 04 | **0** |
| `peeks` | 05 | 05 | **0** |
| `noConfirmation` | 09 | 09 | **0** |
| `anyCorpus` | 08 | 08 | **0** |
| `singleReplicateOk` | 07, 13 | 07, 13 | **0** |
| `hidesDebt` | 11 | 05, 11 | **0** |
| `outageIsQuiet` | 13 | 13 | **0** |
| `metadataIsRegression` | 12 | 12 | **0** |

`mustFail` is a FLOOR, not an exact set: these mistakes are not surgically isolated from one
another, so a mutant may fail more scenarios than it names. What the list must never do is
shrink. Regenerated by `pnpm controls`; seeded, deterministic, makes no provider call.
<!-- /GENERATED -->

Four mutants are caught by **exactly one scenario each**, and that is the number to watch across
releases. Adding scenarios is the easy way to make an existing mutant fail more broadly, and a
mutant whose blast radius quietly widens means the new scenarios are blunt rather than sharp.
`packages/detect/test/suiteDiscriminates.test.ts` asserts it, and it fired when scenario 13 was
added: `singleReplicateOk` left that set, and the reason was checked rather than waved through.

`alwaysQuiet` is the one to read. It never reports drift, so it passes every scenario that asks the
detector NOT to do something: quiet on A/A pairs, never overclaims a tiny effect, never gates on
latency, never manufactures an alarm from repeated looks. A test asserts that running only those
scenarios certifies it. The three that catch it are the three that require a detection.

## The peeking problem, measured

Scenario 05 draws every round at the watcher's own null, so nothing whatsoever is changing.

| procedure | false alarms, 1000 null rounds | false alarms, 4000 null rounds |
|---|---|---|
| e-process (shipped) | 1/40 | 1/40 |
| fixed-alpha test re-run each look (`peeks`) | 15/40 | 15/40 |

The number that matters is that **the e-process rate did not grow when the watch doubled in length.**
That is the always-valid property, visible in data rather than asserted, and the scenario checks it
directly.

## A defect found by review, and the trade-off underneath it

A reviewer of the watch package reported that after 40 quiet ticks a case sat at log-wealth -25.4
against an alarm line of 3.0. Measured properly, against a 19/20 baseline and a quiet stream at 95
percent:

| quiet ticks first | log of the underlying martingale | evidence multiple | ticks to alarm on a real 95 to 60 percent drop |
|---|---|---|---|
| 0 | 0.00 | 1.0x | 14.2 |
| 40 | -23.67 | 8.9x | 97.0 |
| 300 | -174.77 | 59.3x | 620.4 |
| 1000 | -578.90 | 194.2x | 2076.8 |

**A watcher becomes progressively blind the longer it has been well behaved**, and nothing about the
type-I guarantee reveals it, because the guarantee is entirely about false alarms.

The obvious repair is to floor the process at its starting value, which is Page's test. It was
implemented and measured:

| | false alarms, 1000 null rounds | ticks to alarm, 0 quiet | ticks to alarm, 300 quiet |
|---|---|---|---|
| pure e-process | 3% | 12.2 | 617.8 |
| restart at zero | **100%** | 10.8 | 8.8 |

**This is the trade-off itself, not a threshold that needs tuning.** A procedure with a finite
average run length to false alarm will eventually fire on noise by construction; one that never
fires on noise spends a finite error budget and must eventually go quiet. This project keeps the
guarantee and handles the blindness operationally: `evidenceMultiple` reports how much more evidence
the watch now needs than a fresh one would, and `needsRebaseline` fires at 5x. Scenario 11 and the
`hidesDebt` mutant pin it, and `hidesDebt` is caught by scenario 05 as well, because clamping the
martingale to hide the debt IS the restarting statistic and it false-alarms for the reason above.

The debt grows fastest when the baseline is thin, which points at the real cure. `p0` is a Wilson
lower bound, so a small baseline puts it far below the true rate and the process bleeds on nearly
every observation. Re-baselining is the maintenance task; a larger baseline is the fix.

A watch that has been quiet for months is also a watch whose baseline has aged, and
`assessStaleness` was independently going to say so. The two signals coincide because they are the
same fact.

## Defects found and fixed during this pass

Ten. Four were found by tests written after the code, four by reviewers reading it, and two by
running the thing end to end on real data. None was found by re-reading the source.


1. **The refusal detector scored a correct answer as a refusal.** The ported rule was positional: a
   marker inside the first 120 characters counts. A real one-sentence answer in this corpus contains
   "I cannot" at character 66 and is an answer. The refusal rate would have climbed whenever a model
   became more careful in prose, and this project would have reported that as drift. Now requires a
   sentence boundary.
2. **Canonical JSON silently agreed with `JSON.stringify`.** The header argued an undefined property
   must throw; the code filtered it out, doing exactly what it criticised.
3. **The exact Mann-Whitney recurrence was wrong.** It produced plausible p-values. Caught by
   asserting the arrangement counts sum to the binomial coefficient, which they did not.
4. **The peeking mutant escaped its own scenario.** At 20 watches of 300 rounds it alarmed 3 times
   against a threshold of 3. The scenario was too small to resolve the effect it was written to show.
5. **Continuous metrics had no power analysis at all**, so every continuous gating metric that did
   not move counted as unchecked and `NO_DRIFT` was unreachable.
6. **The continuous noise floor was reported in the wrong units.** The calibrated p used relative
   differences and the reported floor used absolute ones, so a latency floor rendered as several
   hundred thousand percent.
7. **The relative difference was unbounded, and this corpus breaks it.** `cnt-c-003` is bimodal: the
   model usually answers in one word and sometimes writes a paragraph, so an A/A half whose draws all
   landed on the short mode gave a ratio of 6430 percent, and that single case dominated the suite's
   noise floor. Now the symmetric percent difference, bounded in [-2, 2].
8. **The A/A calibration was throwing away 80 percent of the data.** Every case was cut to the
   smallest case's half, and one case had errored on 6 of its 10 calls, so all 24 cases were split at
   2 draws per half. Each case now splits its own replicates.
9. **Two corpus cases had attribution too thin to audit**, reading "Narrowed to the decision only."
10. **The JSON report threw on every real comparison, and defect 5 caused it.** Giving continuous
    metrics a power analysis meant setting `allPassCeiling` to NaN, since there is no "all passed" to
    bound on a token count, and canonical JSON refuses NaN by design. `--format json` died with
    `NaN has no JSON representation` on the first continuous metric, which is always. Two correct
    decisions met and produced a broken command; only a test that ran the real binary against the
    real recorded runs found it.

## Em-dashes

Zero em-dashes (U+2014), en-dashes (U+2013), horizontal bars (U+2015), minus signs (U+2212) or any
other dash variant in **any text this project authored**. Enforced by
`packages/spec/test/houseStyle.test.ts`, which walks the repository and builds the characters it
forbids from char codes so the test does not match itself.

**`results/runs/` is excluded, deliberately.** The recorded provider outputs contain em-dashes
because the model wrote them: one baseline reply reads "not semantic correctness - so a payment
destination", with an em-dash where that hyphen is. Those bytes are EVIDENCE. Every grader
re-derives its verdict from that text, both calibration studies re-read it thousands of times, and
rewriting a recorded output to satisfy a style rule would falsify the measurement. The exclusion is
scoped to that one directory and a second test asserts the directory still holds recorded runs, so
the exclusion cannot quietly become a blanket.

## Corpus freeze status

<!-- GENERATED:freeze-status -->
| split | cases | frozen | ordering proof | commit |
|---|---|---|---|---|
| `canary` | 8 | 2026-08-26 | **unavailable** | none recorded |
| `extended` | 16 | 2026-08-26 | **unavailable** | none recorded |
| `schema` | 10 | 2026-08-26 | **unavailable** | none recorded |

**No split has a cashed ordering proof, and `pnpm verify:freeze` exits 1 by design.** It is not pending: it is PERMANENTLY UNAVAILABLE in this repository. The proof requires a commit at which `packages/detect/src/compare.ts` is absent, and that file exists in the first commit, so no commit that exists or ever will exist can satisfy it. `corpus/*/FREEZE.json` carries the recipe for the next repository, which is where it applies.

`pnpm verify:precedence` checks a **weaker and genuinely cashable** claim instead: that each split was committed no later than every recorded run measured against it - so the corpus cannot have been adjusted to flatter a result it had already seen. That is a different sentence and is labelled as one.
<!-- /GENERATED -->

## Still unproven, stated plainly

| Gap | Status |
|---|---|
| **That this tool detects real provider drift** | **Unproven, and this is the biggest gap in the document.** No drift event has been observed. Every positive result is either a synthetic perturbation of recorded outputs or a deliberate swap to a different model, and neither is the thing the tool exists to catch. The false-positive rate is measured; the true-positive rate in the wild is not. |
| **The BYOK HTTP providers** | Shipped and **unrun**. No API key exists in this environment. They are typechecked and exercised against a fake transport, and no number here came from either. |
| **The corpus ordering proof** | **PERMANENTLY UNAVAILABLE, not pending.** The proof requires a commit at which `packages/detect/src/compare.ts` is absent; it exists in the first commit, so no commit that will ever exist can satisfy it. `pnpm verify:freeze` exits 1 by design. `pnpm verify:precedence` cashes a weaker claim - each split was committed no later than every run measured against it - and both splits pass it only in the WEAK form, because the corpus and the runs are in the same commit. |
| **`NO_DRIFT` on the v0.1 corpus specifically** | Not one of 200 A/A splits returned it. `schemaValid` exists on only two cases **in the recorded v0.1 runs**, and two cases give the sign-flip test four sign assignments, and because the test is two-sided the observed assignment and its mirror are both always at least as extreme, so the smallest attainable p is 2/2^2 = 0.5 - so no effect of any size can reach significance on it. The v0.2 corpus takes it to 12 cases, where the floor is 2/4096, and the v0.2 collection **did** return `NO_DRIFT` on two independently collected arms. So this row is a limitation of the v0.1 corpus and not of the tool. |
| **One provider, one model family, one machine** | Everything measured here came through one CLI on one laptop against one vendor. Nothing establishes that the noise floors, the error rates or the alias-resolution behaviour resemble any other provider's. |
| **Latency was collected at concurrency 6** | Recorded in every snapshot and reported, but a burst is not a serial measurement. Latency is observational and cannot gate, which is why this is a caveat rather than a defect. |
| **The A/A pairs were minutes apart** | The measured false-positive rate says nothing about a baseline compared against a candidate collected six weeks later, which meets a different network, a different load and possibly a different region. |
| **Graders are deterministic code, so some drift is invisible** | Drift in a judgement no code can grade cannot be seen. The cases where that is true carry a `detectionLimit` and are reported in their own row rather than hidden. |

## Reproducing this document

```bash
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm build && pnpm test

pnpm audit:release                 # every gate, plus two negative controls that must fire
pnpm verify:corpus                 # byte integrity, 34 cases across three splits
shasum -a 256 -c corpus/canary/MANIFEST.sha256    # the same check, no code from here
pnpm verify:freeze                 # EXPECTED to exit 1. See "Still unproven".

node scripts/run-study.mjs --replicates 10 --positive-control        # prints a cost estimate
node scripts/run-study.mjs --replicates 10 --positive-control --yes  # spends about $1.77
node scripts/calibrate.mjs --splits 200 --trials 40                  # free, makes no call

node packages/cli/dist/cli.js compare \
  --baseline results/runs/baseline.json \
  --candidate results/runs/candidate.json \
  --confirm results/runs/confirmation.json
```

The calibration is fully reproducible from a seed and makes no provider call, so its numbers are
exact on re-run. **The collection is not.** It calls a model at temperature above zero and its
numbers will differ, which is the entire subject of this repository.
