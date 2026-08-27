> [!WARNING]
> **Pre-1.0, and nothing here is published to npm yet.** This package is part of
> [model-regression-sentinel](https://github.com/mstevens843/model-regression-sentinel), whose
> headline limitation comes first: **the tool has never observed a real provider drift event.**
> Every positive result in the repository is a synthetic perturbation of recorded outputs or a
> deliberate swap to a different model, and neither is the thing it exists to catch. The
> false-positive rate is measured; the true-positive rate in the wild is not.

# @model-regression-sentinel/detect

**Telling provider drift apart from sampling noise.** Two nulls, a computed minimum detectable
effect, and always-valid inference for the continuous case.

## The shape of the answer, and why it has four values

| verdict | meaning |
|---|---|
| `NO_DRIFT` | nothing moved, **and** the suite had the power to have seen a movement of the size that matters |
| `INCONCLUSIVE` | nothing was found and the suite could not have found it. Not a degenerate `NO_DRIFT` |
| `SUSPECTED_DRIFT` | a gating metric cleared both nulls. Reported, and does **not** fail a build |
| `CONFIRMED_DRIFT` | the same finding reproduced on an **independently collected** run. Only this fails a build |

`NO_DRIFT` requires both halves. At 10 replicates an all-passing case is still consistent with a true
failure rate of 30 percent, so "we saw nothing" and "we checked" are different statements and only
one of them is supported.

## Two nulls, both reported, never merged

- **The permutation p** asks: is this effect large relative to *sampling*?
- **The calibrated p** asks: is this effect large relative to how much *this provider* wobbles?

A finding must clear both. When they disagree that is information: a permutation p of 0.01 beside a
calibrated p of 0.30 says the effect is real sampling-wise and utterly ordinary for this provider  - 
precisely the case where a raw diff declares a regression and is wrong.

## The peeking problem

A fixed-alpha test in an hourly cron fires about once every twenty hours on a provider that has not
changed. The watcher uses a **test martingale**, so "wealth crossed 1/alpha" is a valid rejection at
any stopping time, with no penalty for looking often. The price is that a long-quiet watch goes
progressively blind; that is reported as an evidence multiple rather than hidden, because a procedure
that never false-alarms must eventually go quiet and a procedure that stays sensitive forever must
eventually false-alarm. You cannot have both.

## Negative controls

The package ships a pool of **detector mutants** - plausible wrong detectors, each modelling a real
mistake - and a meta-test that fails if the calibration scenarios stop discriminating between them. A
suite made only of "does not report drift when there is none" properties is satisfied vacuously by a
detector that never fires, so the mutants are what stop the honesty scenarios from being free.

## Where this fits

| package | what it is |
|---|---|
| `spec` | the frozen case format, the graders, canonical JSON, the freeze discipline. Zero dependencies |
| `run` | provider-agnostic execution: six adapters behind one seam, resolved identity, three latency figures, two cost bounds |
| `baseline` | snapshots as reference points, staleness, and the A/A split the null calibration needs |
| `detect` | the detector: two nulls, a computed MDE, and the e-process for continuous mode |
| `report` | text, markdown and JSON reports, and the gate ledger the exit code is read from |
| `watch` | continuous watching with always-valid inference |
| `cli` | `sentinel`, which is how all of it is actually used |

Full method, assumptions and measured limits:
[docs/STATISTICS.md](https://github.com/mstevens843/model-regression-sentinel/blob/main/docs/STATISTICS.md)
and
[docs/LIMITATIONS.md](https://github.com/mstevens843/model-regression-sentinel/blob/main/docs/LIMITATIONS.md).

MIT.
