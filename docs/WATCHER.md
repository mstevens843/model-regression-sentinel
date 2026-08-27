# The watcher, its evidence debt, and the rebaseline protocol

`sentinel watch --tick` runs one round and exits. Your scheduler owns the schedule. There is no
daemon, because a long-running process needs a real clock and real timers, and a drift sequence that
cannot be replayed deterministically in a test is a sequence nobody can debug.

This document is about the one property of a continuous watcher that is easy to miss and expensive
to discover: **it gets duller the longer it runs quietly, and nothing in its ordinary output says
so.**

---

## Why a watcher is not a scheduled comparison

A fixed-alpha test is valid once. Run it hourly at alpha = 0.05 and, under a null where nothing is
changing at all, it fires roughly once every twenty hours. Every one of those is somebody
investigating a provider that did not change, and after the second or third the alerting gets muted.

So the watcher uses a **test martingale**, an e-process. Wealth starts at 1 and is bet on each
observation; under the null the process is a non-negative martingale, so Ville's inequality bounds
the probability that it EVER crosses `1/alpha`, at any stopping time, over an unbounded number of
looks. Looking often carries no penalty. Nothing has to be decided in advance about how long the
watch will run.

Measured, on a stream where nothing is changing:

| procedure | false alarms, 1000 null rounds | false alarms, 4000 null rounds |
|---|---|---|
| the e-process this ships | 1/40 | 1/40 |
| a fixed-alpha test re-run each look | 15/40 | 15/40 |

The number that matters is that **the e-process rate did not grow when the watch doubled in
length.** That is the always-valid property, visible in data.

## The cost of that guarantee

`p0` is a Wilson **lower** bound on the baseline pass rate, so during a quiet stretch the true rate
sits above it and the process loses on almost every observation. Measured against a 19/20 baseline
with a quiet stream at 95 percent:

| quiet ticks first | evidence multiple | ticks to notice a real 95 to 60 percent drop |
|---|---|---|
| 0 | 1.0x | 14.2 |
| 40 | 8.9x | 97.0 |
| 300 | 59.3x | 620.4 |
| 1000 | 194.2x | 2076.8 |

**A watcher becomes progressively blind the longer it has been well behaved**, and the type-I
guarantee reveals nothing about it, because the guarantee is entirely about false alarms.

### This is a trade-off, not a defect

The obvious repair is to floor the process at its starting value, which is Page's test, the classical
changepoint detector. It was implemented and measured:

| | false alarms, 1000 null rounds | ticks to alarm, 0 quiet | ticks to alarm, 300 quiet |
|---|---|---|---|
| the e-process this ships | 3% | 12.2 | 617.8 |
| restart at zero | **100%** | 10.8 | 8.8 |

The restarting statistic detects in about ten ticks no matter how long the watch has been quiet, and
it alarms on **every** pure-null watch. That is not a threshold needing tuning, it is the trade-off
itself: a procedure with a finite average run length to false alarm fires on noise by construction,
and a procedure that never fires on noise spends a finite error budget and must eventually go quiet.

**This project keeps the guarantee** and handles the dullness operationally, because a monitor people
stop trusting is worth nothing.

## The states

<!-- GENERATED:watcher-protocol -->
| state | evidence multiple | what it means | action |
|---|---|---|---|
| `healthy` | under 2x | about as sensitive as a fresh watch | none |
| `degraded` | 2x to 5x | measurably slower to notice a real regression | plan a rotation |
| `blind` | 5x and above | a regression takes multiples longer to surface than anyone expects | `sentinel baseline rotate` |

`sentinel watch --status` reports the multiple, the ticks in this generation, the ticks across
every generation, and the recommended action. **Spending sensitivity is never a regression and
never sets a non-zero exit code.**
<!-- /GENERATED -->

## The rebaseline protocol

### 1. When it triggers

- `evidenceMultiple` reaches the configured threshold, so `needsRebaseline` becomes true and
  `sentinel watch --status` reports `blind`.
- Or the baseline has aged past the horizon `assessStaleness` uses. **These are usually the same
  event seen from two directions**, and if only one has fired it is worth asking why.
- Or the provider identity moved, which makes the old baseline a reference for a different served
  model regardless of its age.

### 2. What to inspect first, because a rotation destroys all of it

- **The alarm history.** A case that alarmed and settled is evidence. A rotation discards its wealth.
- **The identity alerts.** If the identity moved, the baseline is stale for a reason that is not time,
  and the rotation reason should say so.
- **The baseline's own size.** `p0` is a lower bound, so a thin baseline bleeds fast. Rotating onto
  another thin baseline buys a short reprieve and the same decline. **More replicates is the cure;
  fresher ones are a reprieve.**

### 3. How to rotate

```bash
# See what you have, and what a rotation would cost.
sentinel watch --status

# Collect a new baseline. This spends money and says so first.
node scripts/run-study.mjs --replicates 30

# Dry run: prints the plan, writes nothing.
sentinel baseline rotate --baseline results/runs/new-baseline.json --reason spent_sensitivity

# Apply it.
sentinel baseline rotate --baseline results/runs/new-baseline.json --reason spent_sensitivity --yes
```

`baseline rotate` **refuses** anything that would clear the debt without changing what is measured:

| refusal | why |
|---|---|
| the proposed baseline is the one already being watched | clearing the debt while measuring the same thing is the silent reset this protocol exists to prevent |
| it was captured no later than the current one | a rotation moves forward in time |
| it was collected against a different corpus | that is a different question, not a fresher answer to the same one |
| it grades no case | a watch built on it would bet against a rate nobody measured |

### 4. What carries forward, and what does not

| | |
|---|---|
| **carries** | identity alerts, confirmations, and the full rotation history, including ticks served and how dull the retired generation had become |
| **does not** | the e-process wealth. A new baseline means a new `p0`, so the old wealth was accumulated betting against a different null, and carrying it would be arithmetic across two different questions |

`ticks` resets because it counts ticks of the current generation. **Lifetime ticks do not**, so a
watch on its fourth baseline cannot present itself as one that started this morning.

### 5. Do not simply delete the state file

`sentinel watch --init` **refuses** to write over an existing watch and points at `baseline rotate`.
Deleting the file and re-initialising produces a watch reporting a healthy multiple, no alarm history
and a short life, having learned nothing and forgotten everything. That watch is indistinguishable
from a genuinely fresh one and is **worse than the blind watch it replaced**, because the blind watch
at least said it was blind.

## What a tick can conclude

| status | exit | means |
|---|---|---|
| `quiet` | 0 | observations were folded and no case is alarmed |
| `identity_changed` | 0 | the provider reported a different identity. Orthogonal to behaviour, and reported alongside it |
| `alarm_raised` | 0 | a case crossed. Worth a look. **Does not fail a build** |
| `confirmed_drift` | 1 | an already-alarmed case alarmed again on independently collected data |
| `could_not_look` | 3 | nothing was observed. **Not `quiet`**: those are opposite claims and only one is true |

`could_not_look` returning 3 rather than 2 is deliberate. A watcher that cannot reach its provider
and a watcher pointed at the wrong file are different events with different owners: one is an
incident, the other is a typo.

## Limits

- **The independence assumption is the weakest thing here.** Ville's inequality needs observations
  independent given no drift. Provider behaviour is plausibly autocorrelated in time: a deploy, a
  busy hour, a regional rollout. Positive autocorrelation makes the process less conservative than
  the bound suggests. Using a lower confidence bound for `p0` buys back some margin. It is not a
  proof and this sentence is not a substitute for one.
- **Only `quality` seeds a watch.** It is the one metric that is pass/fail, gating, and means the
  same thing on every archetype. `schemaValid` exists on a subset, so a watch seeded from it would
  cover part of the corpus while presenting a suite-wide number.
- **CUSUM is reported and never triggers.** It localises when a shift began, which the e-process
  cannot, and it carries no any-time guarantee, so it is an aid to reading rather than an alarm.
- **The watcher has never observed real provider drift.** See the top of the README.
