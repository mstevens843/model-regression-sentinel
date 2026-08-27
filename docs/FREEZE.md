# The freeze, and the proof this repository cannot give

Two mechanisms, and they are not the same strength. Conflating them is the mistake this document
exists to prevent.

## What `MANIFEST.sha256` proves

That the corpus bytes have not changed since a digest was recorded.

```bash
pnpm verify:corpus
shasum -a 256 -c corpus/canary/MANIFEST.sha256    # the same check, no code from this project
```

Format, byte for byte, taken from `agent-context-containment` so the two interoperate:

```
<64 lowercase hex><two spaces><repo-root-relative POSIX path>\n
```

sorted by path, LF endings, trailing newline. `FREEZE.json` is **excluded**, deliberately, so that
recording or clearing a freeze can never trip the drift check.

**This is worth having and it is weaker than it sounds:** anyone who can edit the corpus can edit the
manifest in the same change. What it genuinely stops is accidental drift, which is not hypothetical.
The sibling records a `biome check --fix` reformatting the whitespace of three frozen holdout files:
content intact, bytes changed, manifest caught it. That is why `corpus` is in this project's
`biome.json` ignore list on day one.

## What `FREEZE.json` claims, and what it says here

The stronger property is about ORDERING: that the corpus existed at a commit where the detector did
not. Only a git object can carry that.

**In this repository the state is `unavailable`, and it will stay that way.**

```bash
pnpm verify:freeze     # exits 1, by design
```

`corpus/canary/FREEZE.json` records `frozenAtCommit: null`, `state: "unavailable"`, and the reason:
**no git operation was permitted in the environment that produced this repository**, so the corpus
could not be committed before the detector was written.

`unavailable` is not `pending`. Pending means work that remains; unavailable means a proof this
environment cannot produce. `checkFreeze` in `packages/spec/src/freeze.ts` enforces the distinction
by refusing any record whose state and commit disagree in either direction, and a test asserts both
directions.

## What this project adds to the sibling's discipline

1. **A manifest generator.** There is none in `agent-context-containment`; its manifests are produced
   by hand off-repo, which is a seam where a mistake leaves no trace. `pnpm write:manifest` closes
   it, `--check` fails CI when the manifest and the corpus disagree, and a test asserts the script's
   output is byte-identical to what the library produces, so the deliberate duplication cannot drift.
2. **A `FREEZE.json` validator.** The sibling ships two freeze files with different field sets and
   nothing that type-checks either. An evidentiary document with no schema is prose.
3. **A pre-commit hook** that runs `write:manifest --check` when a staged path is under `corpus/`.

## To cash the freeze in a repository that can

```bash
# 1. Author the corpus and the spec it is written against.
# 2. Commit them, with NO detector in the tree.
git log --oneline --diff-filter=A -- corpus

# 3. Confirm the detector is absent there. THIS MUST FAIL:
git cat-file -e <sha>:packages/detect/src/compare.ts

# 4. Record it, verify it, tag it.
pnpm record:freeze canary <sha>
pnpm verify:freeze
git tag -s corpus-canary-v1 <sha>
```

**Do not weaken `scripts/verify-freeze.sh` to make it pass, and do not record a commit that does not
satisfy it.** A freeze check that can be talked into agreeing is worth less than no freeze check,
because it looks like evidence.

## The weaker proof that IS cashable here, and why it has a different name

`pnpm verify:precedence` checks a claim the strict freeze does not, and it must never be quoted as
though it were the strict one.

| | `verify:freeze` | `verify:precedence` |
|---|---|---|
| the claim | the corpus existed at a commit where **the detector did not** | each split was committed **no later than every recorded run measured against it** |
| what it rules out | a corpus written to fit the detector | a corpus adjusted after seeing what it measured |
| state here | **permanently unavailable** | cashable, and partly cashed |
| exits | 1, by design, forever | 0 |

**Why the strict one is permanent rather than pending.** It requires a commit at which
`packages/detect/src/compare.ts` is absent. That file is present in this repository's first commit,
so no commit that exists or will ever exist can satisfy it. "Not yet" would be false. The recipe
above applies to the next repository, not to this one.

**Why the weaker one is still worth having.** The load-bearing half of a freeze claim is not really
"the corpus predates the detector" - it is "the corpus was not tuned to flatter a result". Those come
apart: a corpus written after the detector, but committed before anything was measured against it,
cannot have been adjusted to fit a measurement that did not exist yet. That is checkable, and it is
checkable for every split added from here on.

### What it reports, and what each word means

- **PASS** - the split's cases were committed strictly before every run measured against them.
- **WEAK PASS** - the cases and the runs are in the SAME commit. `git merge-base --is-ancestor X X`
  is true, so this satisfies "not after" without establishing "before". Reported separately because
  those are materially different sentences and only one of them is being claimed.
- **PENDING** - a run exists on disk and is not committed, so it has no position in history yet.
  This is the ordinary state of a working tree straight after a collection. It does not fail.
- **VACUOUS** - no recorded run references this split at all, so there is no precedence to
  establish. Not a pass.

### The state at this freeze

```
canary: PASS - committed at 8e2d99feec86, strictly before every run that measured it.
extended: PASS - committed at 8e2d99feec86, strictly before every run that measured it.
schema: PASS - committed at 072fcc805d55, strictly before every run that measured it.
```

`results/runs-v2/` is now committed after the schema split. That makes `schema` the first split in
this repository to hold the strict form of the weaker precedence claim: the split existed in history
before any committed run measured it. The canary and extended splits also pass: their case files were
committed at `8e2d99f`, strictly before every committed run artifact that measures them.

The output was checked after commit with:

```sh
pnpm verify:precedence
pnpm blocks:check
pnpm audit:release
```

All three passed. `pnpm verify:freeze` still exits 1 by design, because that is the separate strict
freeze proof and remains permanently unavailable in this repository.

## What is frozen, and what is not

| path | frozen | why |
|---|---|---|
| `corpus/canary/*.json` | yes, manifest + CI | 8 cases re-run on every watch tick |
| `corpus/extended/*.json` | yes, manifest + CI | 16 cases used by `compare` |
| `corpus/schema/*.json` | yes, manifest + CI | 10 structured cases added in v0.2, additively |
| `results/runs/*.json` | no | collected runs, reproduced by `scripts/run-study.mjs` |
| `results/calibration.json` | no | regenerated by `scripts/calibrate.mjs`, exactly, from a seed |

The corpus is the instrument. The runs are the measurements. Freezing a measurement would be a
category error.

## Growth is additive, and that is a consequence of the freeze rather than a style

The four runs under `results/runs/` carry a `corpusDigest` computed over exactly the 24 canary and
extended cases, and `compare` refuses two runs whose digests differ. So a case appended to a frozen
split does not merely break a hash: it makes every recorded run `NOT_COMPARABLE`, and those runs
cannot be recollected, because they cost 960 real provider calls and because a re-collection would
sample a different week of the provider that is the thing under observation.

**A new split therefore goes in a new directory, and `loadV1Corpus` keeps the old pair loadable on
its own.** `corpus/schema/` is the first one, added in v0.2 to make the `schemaValid` gating metric
reachable at all. The same discipline is the sibling `agent-context-containment`'s, which keeps
`corpus/holdout` and `corpus/holdout_v2` side by side rather than merging them. `docs/CORPUS.md`
carries the argument and the generated composition table; `packages/run/test/corpusV1Digest.test.ts`
pins the digest against the value recorded in `results/runs/baseline.json`.
