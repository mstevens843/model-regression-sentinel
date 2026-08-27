> [!WARNING]
> **Pre-1.0, and nothing here is published to npm yet.** This package is part of
> [model-regression-sentinel](https://github.com/mstevens843/model-regression-sentinel), whose
> headline limitation comes first: **the tool has never observed a real provider drift event.**
> Every positive result in the repository is a synthetic perturbation of recorded outputs or a
> deliberate swap to a different model, and neither is the thing it exists to catch. The
> false-positive rate is measured; the true-positive rate in the wild is not.

# @model-regression-sentinel/run

**Provider-agnostic BYOK execution of frozen cases**, recording resolved model identity, three
separate latency figures, token counts and two cost bounds.

## The wedge this package exists to observe

A pinned alias resolves to something, and what it resolves to is a fact you can observe. Measured
while building this:

| requested | served identity | context window | max output |
|---|---|---|---|
| `sonnet` | `claude-sonnet-5` | 1,000,000 | 64,000 |
| `haiku` | **`claude-haiku-4-5-20251001`** | 200,000 | not reported |

The `haiku` alias exposes a dated snapshot; `sonnet` does not. **Alias-resolution granularity is
provider-dependent**, so identity is hashed as a fingerprint over everything the provider does
disclose, and undisclosed fields are **named** rather than treated as agreement.

## Five adapters, and which have been run

| adapter | credential | ever run |
|---|---|---|
| `claude_cli` | an authenticated local `claude` CLI | **yes** - every measured number came from it |
| `anthropic_api` | `ANTHROPIC_API_KEY` | **no** - shipped and unrun |
| `openai_compatible` | `OPENAI_API_KEY` + `OPENAI_BASE_URL` | **no** - shipped and unrun |
| `replay` | none | yes - what the tests and both calibration studies use |
| `noop` | none | yes - returns SKIPPED with a reason, so an absent measurement is visible |

**The two HTTP adapters have never made a real call.** They are typechecked and exercised against a
fake transport, and no number in this repository came from either.

## Three states, not two

Every optional provider field is `value`, `not_exposed` or `unknown`. Two absences must never compare
as an agreement: a provider that STOPPED disclosing its context window, compared against an older run
that never captured one, would otherwise show a clean diff on the one field that actually moved.

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
