> [!WARNING]
> **Pre-1.0, and nothing here is published to npm yet.** This package is part of
> [model-regression-sentinel](https://github.com/mstevens843/model-regression-sentinel), whose
> headline limitation comes first: **the tool has never observed a real provider drift event.**
> Every positive result in the repository is a synthetic perturbation of recorded outputs or a
> deliberate swap to a different model, and neither is the thing it exists to catch. The
> false-positive rate is measured; the true-positive rate in the wild is not.

# @model-regression-sentinel/watch

**Continuous canary watching for a pinned model alias**, using an always-valid e-process so repeated
looks do not manufacture false alarms.

## Why continuous monitoring is a different problem

A fixed-alpha test is valid **once**. Run it hourly at alpha = 0.05 and, under a null where nothing
whatsoever is changing, it fires about once every twenty hours. Every one of those is somebody
investigating a provider that did not change, and after the second or third the alerting gets
switched off.

The fix is a **test martingale**: wealth starts at 1 and is bet on each observation, so Ville's
inequality bounds the probability that it ever exceeds 1/alpha, at any stopping time, over an
unbounded number of looks. No alpha-spending schedule, no penalty for looking.

## What one tick can conclude

`quiet`, `identity_changed`, `alarm_raised`, `confirmed_drift`, `could_not_look` - and no two of
those are rephrasings of each other. In particular, **a round in which every call failed is
`could_not_look`, never `quiet`**: an outage is exactly when a provider is most likely to be
mid-change, and a green dashboard through a week of silent failures is how a canary becomes
decoration.

## The trade-off it reports rather than hides

A watch that has been quiet for a long time needs far more evidence to alarm than a fresh one  - 
measured at about 9× after 40 quiet ticks and 59× after 300. This is not a bug that can be patched
away: a procedure that never false-alarms spends a finite error budget and must eventually go quiet.
So the watch tracks how much sensitivity it has spent and **tells the operator to re-baseline**, and
`sentinel baseline rotate` is the only route to clearing it.

`tick` reads no clock, touches no filesystem and calls no provider. It takes the round that was
already collected and the instant it is folded at, which is what makes a drift-over-time sequence
replayable.

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
