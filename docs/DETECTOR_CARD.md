# Detector card

A short, scannable statement of what this detector does, what it assumes, and where it stops
working. `STATISTICS.md` carries the long-form argument and the rejected alternatives.
`../results/CALIBRATION.md` carries the measured numbers and is regenerated, never typed.

---

## What it decides

| | |
|---|---|
| **Question** | Did behaviour move, beyond what this provider's own run-to-run variation produces? |
| **Not the question** | Did my change break something. Use promptfoo for that; it is better at it. |
| **Unit of analysis** | The case, not the replicate. Case difficulty is a huge nuisance factor and pairing removes it. |
| **Inputs** | Two runs of one frozen corpus, several replicates per case per run, plus an independent third run before anything fails a build. |
| **Outputs** | One of five verdicts, an exit code, and a per-metric table with effect sizes and intervals. |
| **Graders** | Deterministic code only. Exact match, regex, JSON Schema, numeric tolerance, refusal lexicon. |

**Why no LLM judge.** A model judge is itself a drifting instrument. Measuring model drift with one
gives a moving ruler and no way to attribute a change to the thing being watched rather than the
thing watching. That is the correct trade here and it genuinely narrows what can be graded: drift in
a judgement no code can score is invisible to this tool, and the cases where that is true carry a
`detectionLimit` and are counted in their own row.

## The five verdicts

| verdict | exit | means |
|---|---|---|
| `NO_DRIFT` | 0 | Nothing moved AND the suite had power to see the effects it searched for. Both halves required. |
| `INCONCLUSIVE` | 0 | Nothing was found and nothing could have been. **Not the same statement as nothing changed.** |
| `SUSPECTED_DRIFT` | 0 | A gating metric cleared both nulls once. Does not fail a build: a threshold is crossed by noise on exactly the run where noise crosses it. |
| `CONFIRMED_DRIFT` | 1 | The same finding reproduced on an independently collected arm. The only verdict that fails a build. |
| `NOT_COMPARABLE` | 2 | The two runs are of different rendered corpora. Misuse, not a provider change. |

Exit 3 is reserved for "could not look": provider unreachable, no credential, rate limited. It is
deliberately not 2 and emphatically not 1.

## Method

| step | choice | rejected alternative |
|---|---|---|
| Primary test | Paired sign-flip permutation on per-case deltas. Exact by enumeration to k=20. | A t-test. No normality assumption is defensible over k bounded proportions, several pinned at 0 or 1. |
| Second null | The baseline split against itself, 500 times, scored with the same statistic. | Assuming a binomial null. A provider adds temperature nondeterminism, routing and load that no parametric family knows about. |
| Effect size | Seeded percentile bootstrap over cases, 2000 resamples. | Reporting a p-value alone. Significance is not magnitude. |
| Continuous metrics | Symmetric percent difference, `2(c-b)/(c+b)`, bounded in [-2, 2]. | Dividing by the baseline. Unbounded, and one bimodal case in this corpus reached 6430 percent and swamped the suite. |
| Per-case screening | Fisher exact or Mann-Whitney, then Benjamini-Hochberg at q=0.10. | Bonferroni. At 34 cases times several metrics it leaves no power, and a screen that never fires is a screen nobody reads. |
| Location estimate | Hodges-Lehmann shift. | A difference of means. One latency sample in eight measured 3.57x the median. |
| Continuous watching | A test martingale with Ville's inequality, valid at any stopping time. | A fixed-alpha test on a schedule. It fires roughly every twenty hours under a pure null. |

## The two nulls, and why a finding must clear both

- **The permutation p** asks whether the effect is large relative to **sampling**.
- **The calibrated p** asks whether it is large relative to **how much this provider measurably
  wobbles on its own**, measured by splitting the baseline against itself.

When they disagree that is information rather than a problem. A permutation p of 0.01 beside a
calibrated p of 0.30 says the effect is real sampling-wise and utterly ordinary for this provider,
which is precisely where a raw diff declares a regression and is wrong.

The calibrated null is **conservative by construction**: each A/A arm holds half the replicates the
real comparison uses, so its quantiles sit wider and the calibrated p is biased toward saying no
drift. Erring toward silence is the right direction for a tool whose main failure mode is crying
wolf.

## Assumptions

| assumption | where it bites | mitigation |
|---|---|---|
| Per-case delta signs are exchangeable under the null | the permutation p | Exact when arms have equal replicates. Otherwise the result is marked approximate and the report says so. |
| Baseline replicates are exchangeable | the calibrated null | Collected in one window against one provider. |
| Case-level tests are independent or positively dependent | Benjamini-Hochberg | Separate prompts, separate graders. The dependence that exists is positive, which BH tolerates. |
| Observations are independent given no drift | the e-process guarantee | **The weakest assumption here.** Provider behaviour is plausibly autocorrelated in time. A conservative `p0` buys margin; this is not a proof. |
| A uniform drop is a realistic drift shape | the MDE | It is the hardest shape to detect, so the MDE is conservative. |
| The provider reports its identity honestly | the fingerprint and metadata | Not verifiable from outside. A vendor can re-tag identical weights, which the report states. |

## Minimum detectable effect

Simulated from the observed per-case baseline rates at the actual replicate count, running the
actual test including its permutation step. Not read off a closed-form formula: on a corpus where
some cases return identical answers on every draw and others are genuinely ambiguous, a formula fed
the average of those variances describes no case in the corpus.

Rates are shrunk toward one half by the Jeffreys prior first, so a case observed at 10/10 does not
enter the simulation as one that can never fail.

**When the observed effect is below the MDE the verdict is `INCONCLUSIVE`, never `NO_DRIFT`, and the
report prints the replicate count that would reach the effect the caller says they care about.**

### The rule of three

With zero failures in n trials, the 95 percent upper bound on the true failure rate is about 3/n.

| replicates | an all-passing arm is still consistent with |
|---|---|
| 5 | a 60% true failure rate |
| **10** (shipped) | **a 30% true failure rate** |
| 30 | a 10% true failure rate |
| 100 | a 3% true failure rate |

This is the honest floor. No amount of staring at a green run gets under it; only replicates do.

## When `INCONCLUSIVE` is the correct answer

- The observed effect is smaller than the MDE at this sample size.
- A gating metric had no resolvable MDE on the search grid.
- Either arm carries fewer than two replicates, so run-to-run variability cannot be estimated at all.

In every one of those cases the tool has learned nothing about the provider, and saying so is the
only defensible output. Reading `INCONCLUSIVE` as a green tick is the single most expensive mistake
this report can cause, which is why it is not rendered as one.

## When `NO_DRIFT` is unreachable, and what it took to reach it

`NO_DRIFT` requires **every gating metric to have been genuinely checked**. A metric carried by too
few cases can never reach significance, so it can never be checked, so the suite can never say
`NO_DRIFT` however clean the data.

**This was the state in v0.1.** `schemaValid` existed on two cases. Two cases give the sign-flip test
four sign assignments and, because the test is two-sided, a smallest attainable p of 2/4 = 0.5, so no effect of any size could
resolve. All 200 A/A splits returned `INCONCLUSIVE` and not one returned `NO_DRIFT`.

**TWO THINGS BLOCKED IT AND ONLY ONE WAS THE CORPUS.** v0.2 adds a `schema` split, taking
`schemaValid` to 12 cases where the floor is 2/4096. That was necessary and not sufficient:
`refusal` is also gating, and the power simulator searched a *drop* in it. On a healthy corpus the
refusal rate is 0, so there was nothing to drop, the simulated power came back flat at every effect
size, and its MDE resolved to `null` on **every** corpus. No amount of collecting would have fixed
that one.

**With both corrected, it was observed.** The 34-case collection returned `NO_DRIFT` on two
independently collected arms:

| gating metric | smallest uniform drop resolvable |
|---|---|
| `quality` | 10.0 pp |
| `schemaValid` | 25.0 pp |
| `refusal` | 8.0 pp |
| `outputTokens` | 15.0% |

The block below is measured on the **v0.1** corpus, where `NO_DRIFT` remains unreachable for the
reason above. [results/CALIBRATION-V2.md](../results/CALIBRATION-V2.md) carries the v0.2 study.

## Measured error behaviour

<!-- GENERATED:calibration-summary -->
| quantity | measured |
|---|---|
| corpus | `7da85be79eb7870d`, 24 cases, 10 replicates |
| A/A false positives | **0 of 200** = 0.0% against a nominal 5.0% |
| live baseline vs candidate arm | `INCONCLUSIVE` |
| first grid point at or above 80% power | 7.0 points |
| predicted MDE | 10.0 points |
| prediction agrees with measurement | yes |
| rule of three at n=10 | an all-passing case still permits a 30.0% failure rate |

Regenerated by `node scripts/calibrate.mjs`. Seeded, makes no provider call, exact on re-run.
<!-- /GENERATED -->

See `../results/CALIBRATION.md` for the current generated numbers, including the A/A false-positive
table, the injected-drift power curve, the predicted-versus-measured MDE, and the continuous-metric
interval summary. That file is produced by `node scripts/calibrate.mjs`, is seeded, makes no provider
call, and reproduces exactly on re-run.

## What this detector cannot do

1. **It has never observed real provider drift.** Every positive result is an injected perturbation
   of recorded outputs or a deliberate model swap. The false-positive rate is measured; the
   true-positive rate in the wild is not.
2. **It cannot name a cause.** It detects that behaviour moved. Whether a vendor changed weights,
   routing, capacity or a safety filter is outside what any client can see.
3. **It cannot score what code cannot grade.** See the LLM-judge note above.
4. **It goes progressively blind on a quiet watch**, by construction rather than by defect. See
   `WATCHER.md` and the `evidenceMultiple` reported by `sentinel watch --status`.
5. **Its latency numbers are observational.** They cannot gate, and across an aged baseline they are
   marked untrustworthy rather than reported as current.
