> [!WARNING]
> **Pre-1.0, and nothing here is published to npm yet.** This package is part of
> [model-regression-sentinel](https://github.com/mstevens843/model-regression-sentinel), whose
> headline limitation comes first: **the tool has never observed a real provider drift event.**
> Every positive result in the repository is a synthetic perturbation of recorded outputs or a
> deliberate swap to a different model, and neither is the thing it exists to catch. The
> false-positive rate is measured; the true-positive rate in the wild is not.

# @model-regression-sentinel/report

**Text, markdown and JSON drift reports, and the gate ledger the exit code is read from.**

## The exit code is the product

Everything else this tool prints is for a person; the exit code is what a pipeline reads, and it is
the one output that must never be wrong.

| code | meaning |
|---|---|
| 0 | nothing confirmed - includes `NO_DRIFT`, `INCONCLUSIVE` and `SUSPECTED_DRIFT` |
| 1 | a confirmed regression that reproduced on an independently collected arm |
| 2 | misuse: bad flags, an unreadable file, mismatched corpora |
| 3 | could not look: the provider was unreachable, or no credential was present |

**Neither 2 nor 3 is 1**, because neither is evidence the provider got worse. Reporting an outage as
a regression is the fastest way to make a drift gate untrustworthy.

## The ledger

Every gate renders as `PASS`, `FAIL`, `SKIPPED`, `NOT RUN` or `FLAG`, and the exit code is read off
those rows rather than re-derived - so the printed table and the exit code cannot disagree.

**`NOT RUN` is not a pass.** A ledger with no `FAIL` in it says only that every gate this run
*measured* was clean. That distinction is most of what this package is for.

## Units are a claim

A percentage point and a percent are different claims, and the renderers keep them apart: a binary
metric's effect is in points, a continuous metric's is a fraction of its own baseline, and the noise
floor and the minimum detectable effect are each rendered in whichever the metric actually uses.

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
