# The corpus: three splits, and why they are three

The corpus is the instrument. Everything else in this repository is plumbing around it, and the
single rule that governs it is that **the instrument does not move while it is measuring.**

## The three splits

| split | cases | run by | paid for |
|---|---:|---|---|
| `canary` | 8 | `watch`, on every tick | forever, so it is deliberately cheap |
| `extended` | 16 | `compare`, on demand | per comparison, so it may be slow |
| `schema` | 10 | `compare`, on demand | per comparison, and added in v0.2 |

**`canary`** is the set re-run on a schedule. Every case in it is `constrained_categorical`, and
that is a budget decision rather than a taste one: the reasoning-heavy archetype measured 10 to 18
seconds and roughly 32 percent output-token variability per call on this machine, and a canary set
nobody can afford to run hourly is a canary set that does not run. It is underpowered by
construction, it says so, and it is never pooled with anything else into one number.

**`extended`** is the fuller set. It carries the slow cases, the free-form cases and the two
original structured ones, because it is run when somebody asks rather than on a timer.

**`schema`** is new in v0.2, and it exists because of a measured defect rather than because more
cases seemed nice. `schemaValid` is a **gating metric**: it can set a non-zero exit code. It is also
the metric a caller notices first when a provider moves, because a model that starts wrapping JSON
in a code fence, or emitting a field the schema forbids, breaks every downstream parser
immediately while a quality score notices nothing.

Before v0.2, `schemaValid` existed on exactly **two** cases. The confirmatory test in this project is
a paired sign-flip permutation test whose unit of analysis is the case, so two cases give it 2^2 = 4
sign assignments and a smallest attainable two-sided p of 0.5. **No effect of any size could ever
reach significance on it.** That is not a sensitivity problem, it is a structural one: the metric was
listed as gating and could not be checked, so every comparison answered `INCONCLUSIVE` and the
verdict `NO_DRIFT` was unreachable. `results/CALIBRATION.md` records the consequence: 200 of 200 A/A
splits returned `INCONCLUSIVE` and not one returned `NO_DRIFT`.

**THE SPLIT DID WHAT IT WAS ADDED TO DO.** A collection over all 34 cases returned `NO_DRIFT` on two
independently collected arms, with `schemaValid` resolving a minimum detectable effect of 25.0 points
against `null` on the v0.1 corpus. It took one other thing as well, and that one was a defect rather
than a corpus limit: `refusal` had its power simulated in the wrong direction, so its MDE never
resolved on any corpus and no amount of collecting would have fixed it. Both had to be right.
`results/CALIBRATION-V2.md` records the result.

A verdict vocabulary with an unreachable value has one fewer value than it claims, and the one it
loses here is the one people most want to see. The `schema` split takes `schemaValid` to 12 cases,
which is 4,096 sign assignments and a smallest attainable p of about 0.0005.

## Why the v0.1 pair is frozen separately, and why growth is additive

`corpus/canary/` and `corpus/extended/` hold 24 cases whose bytes are covered by their
`MANIFEST.sha256` files. Four real provider runs live under `results/runs/`: 960 calls against a
pinned alias, collected with real money, and **each one stores a `corpusDigest` computed over
exactly those 24 rendered requests.**

`compare` refuses to compare two runs whose `corpusDigest` differs, and it is right to. Two runs of
different corpora differ by experiment rather than by provider, and a tool that averaged over that
difference would report drift that is an artifact of its own maintenance.

So **appending a case to `corpus/extended/` would make every recorded run `NOT_COMPARABLE`**, and
those runs cannot be recollected: live provider calls were not authorised for the v0.2 pass, and
re-collecting them would in any case sample a different week of a provider that is the thing under
observation. `results/calibration.json` and `results/CALIBRATION.md` are derived from those runs and
would go with them.

The corpus therefore grows **additively, as a new directory beside the frozen ones, forever.** That
is the same move the sibling project `agent-context-containment` makes with `corpus/holdout` and
`corpus/holdout_v2`, and it is written down in `corpus/canary/FREEZE.json` and `docs/FREEZE.md`.

Two consequences worth stating plainly:

1. `loadV1Corpus(root)` exists and must not be deleted. It loads canary plus extended and nothing
   else, and anything that reads the recorded runs has to go through it: `scripts/calibrate.mjs`,
   the A/A false-positive study, and the power curve. `loadCorpus(root)` loads all three splits and
   is what a NEW comparison should use. A test pins the v0.1 digest against the value recorded in
   `results/runs/baseline.json`.
2. The numbers in `results/CALIBRATION.md` are v0.1 numbers, measured on 24 cases. They stay
   published beside the larger corpus rather than being quietly restated over it.

## The schema evolution rule: optional fields only, forever

`EvalCase.schemaVersion` is the literal `1` and there is no migration path, by design. A required
field could never be added, because adding one would have to rewrite files whose digests are the
instrument. So every field added after v0.1 is optional, and `checkCorpus` ignores fields it does not
know about rather than refusing them, so a case written by a newer writer stays readable by the thing
that froze it.

`sourceTrace` is the first field added under that rule. It records, in fields rather than in prose,
which sibling repository a case's decision content came from, the path inside it, the symbol or case
id, and one line separating what was carried over from what this project invented. It is present on
all 10 `schema` cases and on none of the frozen 24, and that asymmetry is permanent.

## What every case must satisfy

`checkCorpus` in `packages/spec/src/corpus.ts` returns every violation rather than the first. The two
rules that are not obvious:

- **`REQUIRED_SIGNAL_UNGRADED`.** A case names the metric that must move for a detection on it to
  count. If it names `quality` and ships no grader, nothing can ever make `quality` move and the case
  is decoration reporting green forever.
- **`ARCHETYPE_SPAN`**, checked over the union of splits rather than per split. Latency CV measured
  7.5 percent on a constrained case and 70.8 percent on a free-form one. Those are different noise
  regimes, and a corpus that does not span them is a corpus tuned on one easy shape.

And one rule that keeps the corpus honest about itself: **`NO_MEASURABLE_CASES`** fires if every case
declares a `detectionLimit`. A case with a non-null `detectionLimit` is saying that some drift is
structurally invisible to it, and those cases are counted in their own row rather than dropped. A
corpus with no out-of-scope cases is a rigged corpus.

## Composition

Generated by `node scripts/case-composition.mjs`. Run it with `--check` to fail when it is stale;
nothing outside the markers is generated.

<!-- GENERATED:case-composition -->

| split | `constrained_categorical` | `constrained_numeric` | `free_form` | `structured_json` | total |
|---|---:|---:|---:|---:|---:|
| `canary` | 8 | 0 | 0 | 0 | **8** |
| `extended` | 10 | 2 | 2 | 2 | **16** |
| `schema` | 0 | 0 | 0 | 10 | **10** |
| **all** | **18** | **2** | **2** | **12** | **34** |

| provenance origin | cases |
|---|---:|
| derived from `agent-context-containment` | 15 |
| derived from `durable-agent-outbox` | 15 |
| derived from `toolcall-risk-classifier` | 2 |
| original | 2 |

| property | cases |
|---|---:|
| declare a `detectionLimit`, and are reported in their own row | 12 |
| declare a `jsonSchema`, so `schemaValid` is producible on them | 12 |
| carry a `sourceTrace` | 10 |
| total | 34 |

<!-- /GENERATED -->

## Adding a split

1. Write the cases in a new directory under `corpus/`. Give their ids a new infix and add it to
   `SPLIT_INFIX` in `packages/spec/src/types.ts`, so a case relabelled out of a frozen split changes
   its id and shows up in every diff.
2. Write `FREEZE.json`. `checkFreeze` validates it and a test asserts it. If the ordering proof
   cannot be obtained, say `unavailable` and say why. `unavailable` is not `pending`.
3. Run `node scripts/write-manifest.mjs`. It picks up new directories on its own. Then check it the
   way a stranger would: `shasum -a 256 -c corpus/<split>/MANIFEST.sha256`.
4. Run `node scripts/case-composition.mjs` and re-read the prose above it.
5. **Do not touch the frozen splits.** If `bash scripts/verify-corpus.sh` fails, find out what wrote
   to the file before you regenerate anything. Regenerating a manifest to make a red check go green
   is the one move that turns a working integrity check into decoration.
