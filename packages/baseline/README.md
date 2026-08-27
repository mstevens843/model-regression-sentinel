> [!WARNING]
> **Pre-1.0, and nothing here is published to npm yet.** This package is part of
> [model-regression-sentinel](https://github.com/mstevens843/model-regression-sentinel), whose
> headline limitation comes first: **the tool has never observed a real provider drift event.**
> Every positive result in the repository is a synthetic perturbation of recorded outputs or a
> deliberate swap to a different model, and neither is the thing it exists to catch. The
> false-positive rate is measured; the true-positive rate in the wild is not.

# @model-regression-sentinel/baseline

**Snapshot a run as a reference, storing RAW OUTPUTS** so a later analysis can ask new questions of
an old run - plus the A/A split the null calibration is built from.

## Why raw outputs

Grading happens from raw text, every time, and nothing is read back from a stored verdict. The rule
comes from a sibling project where a stored parse went stale and every refusal in a 494-call run had
been scored as a confident answer until someone audited it.

Re-deriving means a grader fix re-grades every archived run for free. It is also what makes
calibration affordable: the A/A study and the power curve re-read the same recorded outputs thousands
of times, and if grading were baked in at collection time the detector could only be calibrated by
paying for new calls.

## The staleness verdict

A baseline ages, and the metrics age differently. Behavioural metrics survive a six-week-old
reference; **latency does not**, because it meets today's network, today's provider load and today's
routing. This package degrades its trust in those metrics rather than reporting them as though they
were current.

## The A/A split

`manyAaSplits` cuts a baseline's replicates into random halves so the detector can be scored against
a condition where drift is known to be absent. That is what turns "the detector reported no drift"
into a measured false-positive rate.

## Where this fits

| package | what it is |
|---|---|
| `spec` | the frozen case format, the graders, canonical JSON, the freeze discipline. Zero dependencies |
| `run` | provider-agnostic execution: five adapters, resolved identity, three latency figures, two cost bounds |
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
