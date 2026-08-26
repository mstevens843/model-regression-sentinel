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

## 3. One provider, one model family, one machine

Everything measured here came through one CLI, on one laptop, against one vendor. Nothing establishes
that the noise floors, the error rates or the alias-resolution behaviour resemble any other
provider's. The two BYOK HTTP adapters exist so that someone with a key can find out; they have never
been run.

## 4. `NO_DRIFT` is unreachable on the shipped corpus

Not one of 200 A/A splits returned it. A `NO_DRIFT` verdict requires every gating metric to have been
genuinely checked, and `schemaValid` exists on only two cases, which gives the sign-flip test four
possible assignments and a smallest attainable p of 0.25. No effect of any size can reach significance
on it, so the suite answers `INCONCLUSIVE`. Honest, and inconvenient. More schema cases would fix it.

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
- **The corpus is 24 cases chosen by the same person who wrote the detector.** A case can fail to
  discriminate simply because nothing here is hard enough.
