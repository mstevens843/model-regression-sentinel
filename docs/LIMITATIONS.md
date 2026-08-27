# Limitations

Ordered by how much they should change your reading of this repository, most first.

## 1. This tool has never observed a real provider drift event

Every positive result here is either a synthetic perturbation of recorded outputs or a deliberate
swap to a different model. **Neither is the thing the tool exists to catch.** The false-positive rate
is measured on real data; the true-positive rate in the wild is not measured at all, and cannot be
until a provider changes something and this happens to be watching.

That is not a defect that can be engineered away. It is the state of a detector that has not yet had
the event it detects, and it is the first thing this README says.

## 2. Deterministic graders cannot score everything

An LLM judge is itself a drifting instrument, so a tool that measures model drift with one has a
moving ruler and cannot attribute a change to the thing it is watching rather than to the thing it is
watching with. That is the correct trade here and it is a real cost: drift in any judgement no code
can grade is invisible.

Cases where that is true carry a `detectionLimit` naming what they cannot see, and are reported in
their own row rather than counted in the headline. A corpus with none of those would be a rigged
corpus.

## 3. Every published claim rests on one provider

Everything this repository publishes came through one CLI, on one laptop, against one vendor:
`results/runs/`, `results/runs-v2/`, both calibration studies, the mutant discrimination table and
every generated block. Nothing establishes that the noise floors, the error rates or the
alias-resolution behaviour resemble any other provider's.

**A second vendor has been reached, and it changes less than it sounds like.** The `codex_cli`
adapter runs on a local Codex plan session and has made 40 live calls over the 8-case canary split.
That is **supplementary evidence**: it gates nothing, it appears in no calibration study, and its
artifacts are in `results/live-codex/` rather than beside the paid collections. What it demonstrates
is that the provider seam is not shaped around one vendor. What it does **not** demonstrate is
anything about noise floors elsewhere, and it cannot corroborate the alias-resolution wedge at all,
because Codex discloses no served model identity for any alias.

**The two BYOK HTTP adapters remain unrun.** They speak to deployed endpoints and need a key this
environment does not have. A plan-backed CLI is a third thing and does not close that gap.

## 4. `NO_DRIFT` is unreachable on the v0.1 corpus, and was observed on the v0.2 one

**Read the version numbers in this one carefully, because they are the whole content.**

Not one of 200 A/A splits returned `NO_DRIFT`. A `NO_DRIFT` verdict requires every gating metric to
have been genuinely checked, and in **the v0.1 corpus the four recorded runs were collected
against** `schemaValid` exists on only two cases. Two cases give the sign-flip test four sign
assignments, and because the test is two-sided the observed assignment and its mirror are both
always at least as extreme - so the smallest attainable p is 2/2^2 = 0.5. No effect of any size can
reach significance on it, and the suite answers `INCONCLUSIVE` instead.

**A second blocker was a defect, and it is fixed.** `refusal` is also gating, and the power
simulator searched a *drop* in it. On any healthy corpus the refusal rate is 0, so there is nothing
to drop: the simulated power came back flat at about 33 percent for every effect size on the grid
and the MDE resolved to `null` at every size. That blocked `NO_DRIFT` on **every** corpus, not only
on one short of schema cases, and no amount of collecting would have fixed it. The simulator now
searches the direction each metric actually degrades in - a rise, for a refusal rate - and `refusal`
resolves an MDE of about 8 points on the recorded runs.

**AND THEN IT WAS OBSERVED.** With both fixed, the 34-case v0.2 collection returned `NO_DRIFT` on
two independently collected arms against one pinned alias, with every gating metric resolving a
minimum detectable effect: `quality` 10.0 pp, `schemaValid` 25.0 pp, `refusal` 8.0 pp,
`outputTokens` 15.0%. That is the first `NO_DRIFT` verdict this project has produced on real
provider outputs. It is recorded in [RESULTS.md](../RESULTS.md) and
[results/CALIBRATION-V2.md](../results/CALIBRATION-V2.md).

**THIS SECTION IS NOW A LIMITATION OF ONE CORPUS, NOT OF THE TOOL**, and it is kept because the
v0.1 recorded runs are still the evidence behind `results/CALIBRATION.md`, and on those 24 cases
`NO_DRIFT` remains unreachable for the reason above. Do not read this section as a live constraint
on what the detector can do.

**v0.2 made it structurally reachable and did not make it observed.** The `schema` split takes
`schemaValid` from 2 cases to 12, where the floor is 2/4096 rather than 2/4. That is a fact about
the corpus. Whether `NO_DRIFT` is reachable against a real provider is a fact about data, and the
only evidence this repository has was collected against the 24-case corpus, so **nothing here has
yet observed a `NO_DRIFT` verdict on real outputs.** A fresh collection over all 34 cases is the
experiment that would answer it, and it has not been run.

## 5. The watcher goes progressively blind, and the fix is operational

A watch that has been quiet for a long time needs far more evidence to alarm than a fresh one:
measured at 8.9x after 40 quiet ticks and 59x after 300. This is not a bug that can be patched away.
A procedure that never false-alarms spends a finite error budget; one that stays sensitive forever
false-alarms eventually. The restarting alternative was implemented and measured at a 100 percent
false alarm rate on pure-null streams.

The tool reports `evidenceMultiple` and asks to be re-baselined at 5x. **A larger baseline is the
real cure**, because `p0` is a Wilson lower bound and a thin baseline puts it far below the true rate.

## 6. An aged baseline narrows what can be compared

Latency and cost comparisons across an old baseline meet a different network, a different load and
possibly a different region, none of which this tool observes. `assessStaleness` degrades their trust
past the horizon rather than reporting them as current. Behavioural metrics survive ageing far
better, which is why the two are aged on different clocks.

## 7. The measured false-positive rate says nothing about time

Both A/A arms were collected minutes apart. Zero false positives in 200 splits of that data does not
establish anything about a baseline compared against a candidate six weeks later.

## 8. Correlation with a cause is not established, ever

This tool detects that behavior moved. It does not and cannot establish that a provider changed a
model, as opposed to changing routing, capacity, a safety filter, a system prompt, or something
nobody outside the vendor can name. Every report says so in the verdict block, because the most
likely misreading of a confirmed finding is that it names a cause.

## 9. Smaller, and still worth knowing

- **The JSON Schema checker implements a documented subset.** It reports the keywords it does not
  implement rather than ignoring them, but a case relying on `allOf` is validated more loosely than
  its author intended.
- **The refusal detector is an English lexicon** anchored at sentence starts. A model that declines
  in a form not on the list is scored as having answered.
- **Latency was collected at concurrency 6.** Recorded and reported, but a burst is not a serial
  measurement. This is a caveat rather than a defect only because latency cannot gate.
- **Synthetic calibration draws from parametric families.** Real provider nondeterminism has
  structure no family captures, so a false-positive rate measured against synthetic data is a lower
  bound. The A/A study on recorded outputs is the stronger evidence and is the one quoted.
- **The corpus is 34 cases chosen by the same person who wrote the detector.** A case can fail to
  discriminate simply because nothing here is hard enough.
