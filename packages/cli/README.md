> [!WARNING]
> **Pre-1.0, and nothing here is published to npm yet.** This package is part of
> [model-regression-sentinel](https://github.com/mstevens843/model-regression-sentinel), whose
> headline limitation comes first: **the tool has never observed a real provider drift event.**
> Every positive result in the repository is a synthetic perturbation of recorded outputs or a
> deliberate swap to a different model, and neither is the thing it exists to catch. The
> false-positive rate is measured; the true-positive rate in the wild is not.

# @model-regression-sentinel/cli

**`sentinel`** - freeze, run, baseline, compare, watch and report.

```bash
# What is frozen, and does it still match its manifest.
sentinel corpus

# Compare. Exit 1 ONLY on a regression confirmed by an independent second run.
sentinel compare --baseline baseline.json --candidate candidate.json --confirm confirmation.json

# Watch. Initialise once, then one tick per invocation; your scheduler owns the schedule.
sentinel watch --init --baseline baseline.json
sentinel watch --tick
sentinel watch --status
```

## Exit codes, which are the actual product

| code | meaning | what to do |
|---|---|---|
| 0 | nothing confirmed | read the verdict: `INCONCLUSIVE` is not the same claim as `NO_DRIFT` |
| 1 | a confirmed regression | investigate. Check identity and corpus digest before assuming a model changed |
| 2 | misuse | fix the invocation. Nothing is known about the provider from this run |
| 3 | could not look | an outage, not a regression. Retry, and do not record the round as quiet |

## Corpus splits

`--split v1` is the 24-case pair the recorded runs were collected against; `--split all` is all 34.
They produce different corpus digests, and `compare` refuses two runs whose digests differ - two runs
of different corpora differ by *experiment* rather than by provider.

## Nothing fails a build without confirmation

A single threshold crossing is `SUSPECTED_DRIFT` and exits 0. It becomes `CONFIRMED_DRIFT` only when
it reproduces on an independently collected run. A build that fails on a single crossing is a build
that fails on noise, and the second time that happens the gate gets removed.

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
