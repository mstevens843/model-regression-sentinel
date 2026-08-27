# Defects found

Recorded because they are the most useful thing in the repository. Each entry says what was wrong,
what it would have cost, how it was found, and what now stops it coming back.

The pattern worth noticing across all of them: **not one was found by re-reading the source.** They
were found by tests written after the code, by reviewers reading it with a different question in
mind, by running the real binary against real data, and by an adversarial sweep whose only purpose
was to make the thing fail.

---

## v0.2

### 1. Two absences compared as equal facts

**Wrong.** Every optional provider field was `number | null`, and `null` meant two different things:
"the provider was asked and does not report this" and "nobody ever found out". Diffing two nulls
produced "unchanged".

**Cost.** A provider that STOPPED disclosing its context window, compared against an older run that
never captured one, showed a clean diff on the one field that had actually moved. "Unchanged" reads
as evidence of stability and was nothing of the kind.

**Found by** designing the metadata comparison and asking what `null === null` was actually
asserting.

**Fixed by** `MetaValue`, a three-state type: `value`, `not_exposed`, `unknown`. The comparison emits
`indeterminate` and `both_absent` rows rather than filtering them, because their whole purpose is to
be visible. `packages/run/test/metadata.test.ts` pins every state transition.

### 2. `calibratedP` and `noiseFloor95` were NaN, and broke JSON output

**Wrong.** When the baseline was too thin to split for A/A calibration, both fields were set to
`Number.NaN`. `canonicalJson` refuses NaN by design, because `JSON.stringify` would silently write
`null` and let two different objects hash the same.

**Cost.** `sentinel compare --format json` threw on **any** run with fewer than four replicates per
case, which is precisely the underpowered run a user is most likely to be inspecting. The v0.1 test
suite missed it because every test used the ten-replicate recorded runs.

**Found by** an adversarial sweep over degenerate corpora: all-perfect, all-failing, knife-edge,
single-case, at one through ten replicates. It reported 98 findings on the first run.

**Fixed by** making both fields `number | null` at the source. `exceedsNoiseFloor` propagates the
null, so an uncalibrated run can never produce a confirmed regression. Guarded by
`packages/detect/test/serializable.test.ts`, which sweeps 25 compare configurations and 8 MDE
configurations for any non-finite number and then round-trips each through canonical JSON.

**This is the third time this class of bug has appeared.** See v0.1 entry 10 and v0.2 entry 3. The
rule is now written down: anything crossing a serialization boundary must be finite or null, and NaN
is an in-memory sentinel only.

### 3. `allPassCeiling` was NaN at the source, patched at the boundary

**Wrong.** v0.1 fixed the JSON symptom by nulling the field in the renderer while leaving `NaN` in
the type. Every other consumer still had to know.

**Fixed by** changing `MdeResult.allPassCeiling` to `number | null` and returning null for continuous
metrics, where there is no "all passed" to bound. The report's ceiling pickers now skip a finding
whose ceiling is absent rather than presenting an absence as a number.

### 4. A malformed HTTP 200 was silently gradeable

**Wrong.** A response with a valid status and an unexpected body returned `text: ""` with
`error: ""`. `packages/detect/src/metrics.ts` grades exactly the records whose error is empty.

**Cost.** A provider serving broken bodies would have been reported as **a model that got worse**.
That is the single most damaging failure mode this project has, because it is the tool's own output
in its own voice, and it is wrong.

**Found by** a fake-transport sweep asking what every failure mode returns, rather than what the
happy path returns.

**Fixed by** an envelope check plus a second guard: no text and no stop reason is refused. An empty
reply WITH a stop reason is left alone, because a `max_tokens` truncation is real behaviour.

### 5. `undisclosedFields` did not report `resolvedModel`

**Wrong.** An absent `model` field yields `""`, and `"" === ""` forever.

**Cost.** A provider that never disclosed what it served read as one whose identity was perfectly
stable, which is the opposite of the truth and sits directly under this project's central claim.

**Fixed by** one line, plus the metadata work in entry 1 that makes the general case impossible.

### 6. The exit-code contract disagreed with itself between two commands

**Wrong.** `sentinel run` returned 2 when no credential was present. `sentinel watch --tick` returned
3 for the identical condition.

**Cost.** A pipeline cannot distinguish an outage from a typo when the same tool reports the same
event two ways. It would eventually page the wrong person, or learn to ignore both.

**Found by** a reviewer reading two commands side by side.

**Fixed by** `packages/spec/src/exitCodes.ts`, one vocabulary shared by every command and rendered
into `--help`, plus `packages/cli/test/contract.test.ts`, which checks the codes by RUNNING THE
BINARY rather than by calling a function that returns a number.

### 7. A watch could be silently reset by deleting a file

**Wrong.** `watch --init` would happily write over an existing watch.

**Cost.** The worst failure in the watcher. Deleting the state file and re-initialising produces a
watch reporting a healthy evidence multiple, no alarm history and a short life, having learned
nothing and forgotten everything. It is indistinguishable from a genuinely fresh watch and is
**worse than the blind watch it replaced**, because the blind one at least said it was blind.

**Fixed by** a refusal that names `sentinel baseline rotate`, reports what would be lost, and exits
2. Rotation itself requires a newly collected artifact and refuses four ways.
`packages/cli/test/restartGuard.test.ts` drives the real binary.

### 8. A header cited a test file that does not exist

**Wrong.** `httpApi.ts` pointed readers at `packages/run/test/secrets.test.ts`.

**Cost.** Small and corrosive. A comment citing evidence that is not there is worse than no comment,
because it is checkable and a reader who checks stops trusting the rest.

**Fixed by** repointing it at the files that do exist.

---

## v0.1

Carried forward. Full narrative in `../RESULTS.md`.

1. The refusal detector scored a correct answer as a refusal, because the rule was positional and a
   real one-sentence answer contains "I cannot" at character 66. The refusal rate would have climbed
   whenever a model became more careful in prose, and this project would have reported that as
   provider drift.
2. Canonical JSON silently agreed with `JSON.stringify`: the header argued an undefined property must
   throw and the code filtered it out.
3. The exact Mann-Whitney recurrence was wrong and produced plausible p-values. Caught by asserting
   the arrangement counts sum to the binomial coefficient.
4. The peeking mutant escaped its own scenario, because the scenario was too small to resolve the
   effect it was written to show.
5. Continuous metrics had no power analysis at all, so `NO_DRIFT` was unreachable.
6. The continuous noise floor was reported in the wrong units and rendered as several hundred
   thousand percent.
7. The relative difference was unbounded, and one bimodal case reached 6430 percent and dominated the
   suite's noise floor.
8. The A/A calibration threw away 80 percent of the data by cutting every case to the smallest one's
   half.
9. Two corpus cases had attribution too thin to audit.
10. The JSON report threw on every real comparison, because a correct decision about NaN met a
    correct decision about canonical JSON.
