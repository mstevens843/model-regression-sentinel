> [!WARNING]
> **Pre-1.0, and nothing here is published to npm yet.** This package is part of
> [model-regression-sentinel](https://github.com/mstevens843/model-regression-sentinel), whose
> headline limitation comes first: **the tool has never observed a real provider drift event.**
> Every positive result in the repository is a synthetic perturbation of recorded outputs or a
> deliberate swap to a different model, and neither is the thing it exists to catch. The
> false-positive rate is measured; the true-positive rate in the wild is not.

# @model-regression-sentinel/spec

**The frozen eval-case format, and the freeze discipline that makes a corpus an instrument rather
than a suggestion.** Zero dependencies.

## Why this exists

A drift detector's corpus is the instrument that measures the provider. If it can be edited - by a
person, by a formatter, by an editor stripping a trailing newline - then every drift verdict measured
against it is unfalsifiable, because the thing being measured and the thing measuring it are both
under the same hand. That is worse here than in an ordinary eval: a detector whose corpus moved will
report drift, and the report is indistinguishable from the real thing.

## What is in it

- **The case schema.** Content-hashed, versioned, validated, with a negative control per violation
  code.
- **Deterministic graders only.** An LLM judge is itself a drifting instrument: a tool that measures
  model drift with a model has a moving ruler. That rules out the most flexible grading method
  available, it genuinely narrows what can be scored, and it is the correct trade here and only here.
- **A JSON Schema subset** that **reports the keywords it does not implement** rather than ignoring
  them, so a case cannot quietly validate more loosely than it is written.
- **Canonical JSON** that refuses `undefined`, `NaN`, `Infinity`, `-0` and any non-plain object,
  because `JSON.stringify` would silently drop or flatten them and two different objects would hash
  the same.
- **The exit-code contract**, in one place: 0 nothing confirmed, 1 a confirmed regression, 2 misuse,
  3 could not look.

## Honest limits

The refusal detector is a **lexicon of English sentence-openers**; a model that declines in a form
not on the list is scored as having answered. The JSON Schema checker implements a documented
subset. Both are heuristics, and both say so where they are used.

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
