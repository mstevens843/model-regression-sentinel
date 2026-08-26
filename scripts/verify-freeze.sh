#!/usr/bin/env bash
#
# STRICT freeze verification. Optional, and it fails until the freeze is actually cashed.
#
# `verify-corpus.sh` proves the corpus matches a digest. That is worth having and it is weaker than
# it sounds: it proves the files match a digest recorded at SOME point, not that the digest was
# recorded before the detector existed - and anyone who can edit the corpus can edit the manifest in
# the same change. This script checks the stronger property, which only a git object can carry:
#
#   the corpus existed at a commit where packages/detect/src/compare.ts did not.
#
# That is what makes "the corpus was not written to fit the detector" a fact a stranger can check in
# five seconds rather than a claim they have to take on trust.
#
# BOTH SPLITS ARE CHECKED. corpus/canary and corpus/extended each carry their own FREEZE.json, and a
# freeze that covers the canary alone would be a freeze over the eight cases nobody was tempted to
# tune. The loop is over `corpus/*/FREEZE.json` rather than a hardcoded pair, so a third split
# cannot be added and quietly left unfrozen.
#
# WHAT THIS DOES NOT CHECK. Whether `state` and `frozenAtCommit` agree is the business of
# `checkFreeze` in packages/spec/src/freeze.ts, which rejects a record claiming `unavailable` while
# carrying a commit. This script asks git the four questions git can answer and nothing else. Two
# checkers with one job each beat one checker that can be argued with.
#
# Kept OUT of normal CI on purpose. CI gates on the manifest, which always passes; this fails loudly
# until a human does the one-time procedure, and a check that is red by design does not belong in a
# pipeline everyone learns to ignore.
#
# EXIT CODES: 0 the freeze holds, 1 the freeze claim fails, 2 the environment could not answer.

set -euo pipefail

cd "$(dirname "$0")/.."

ENGINE="packages/detect/src/compare.ts"

found=0
fail=0
UNCASHED=()

for freeze in corpus/*/FREEZE.json; do
  [ -f "$freeze" ] || continue
  found=$((found + 1))

  # Read through node rather than grep, so a malformed record is a loud environment fault instead of
  # a regex that silently matches nothing and reports "not cashed" for the wrong reason.
  if ! commit=$(node -e '
    const f = require("fs");
    const j = JSON.parse(f.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(j.frozenAtCommit ?? ""));
  ' "$freeze" 2>/dev/null); then
    echo "verify-freeze: $freeze could not be read as JSON." >&2
    exit 2
  fi

  # CHECK 1: a commit is recorded at all. Null is a real answer here and the message below says so.
  if [ -z "$commit" ] || [ "$commit" = "null" ]; then
    UNCASHED+=("$freeze")
    fail=1
    continue
  fi

  if ! command -v git >/dev/null 2>&1; then
    echo "verify-freeze: git is not available, so the commit cannot be checked." >&2
    exit 2
  fi

  echo "verify-freeze: checking that $ENGINE was absent at $commit ($freeze)"

  # CHECK 2: the recorded sha is a commit in THIS repository. A sha from another clone, or a typo,
  # would otherwise sail through the remaining checks by being unresolvable rather than by being
  # right.
  if ! git rev-parse --quiet --verify "$commit^{commit}" >/dev/null 2>&1; then
    echo "verify-freeze: $commit is not a commit in this repository ($freeze)." >&2
    fail=1
    continue
  fi

  # CHECK 3: the engine must be ABSENT at that commit. This is the whole proof. It is written as a
  # command that must fail, because the absence of a file is the evidence and there is no way to
  # assert it positively.
  if git cat-file -e "$commit:$ENGINE" 2>/dev/null; then
    cat >&2 <<MSG

--------------------------------------------------------------------------------
FREEZE INVALID: the detector already existed at the recorded commit.
--------------------------------------------------------------------------------

  $ENGINE is present at $commit, recorded in $freeze.

The corpus's whole claim is that it was authored before the detector, so a freeze
point where the detector exists proves nothing. Either the wrong sha was
recorded, or the ordering did not hold. Do not adjust this script to pass.
--------------------------------------------------------------------------------
MSG
    fail=1
    continue
  fi

  # CHECK 4: the freeze point is on the history that leads to HEAD. A commit on an abandoned branch
  # can witness anything you like and says nothing about the tree a reader is holding.
  if ! git merge-base --is-ancestor "$commit" HEAD 2>/dev/null; then
    echo "verify-freeze: $commit is not an ancestor of HEAD ($freeze)." >&2
    echo "The freeze is not on this history, so it witnesses nothing about this tree." >&2
    fail=1
    continue
  fi

  echo "verify-freeze: OK - $freeze predates $ENGINE, verified at $commit."
done

if [ "$found" -eq 0 ]; then
  echo "verify-freeze: no corpus/*/FREEZE.json found. Run this from the repository root." >&2
  exit 2
fi

if [ "${#UNCASHED[@]}" -gt 0 ]; then
  {
    echo
    echo "--------------------------------------------------------------------------------"
    echo "FREEZE NOT CASHED: these freeze records carry frozenAtCommit: null"
    echo "--------------------------------------------------------------------------------"
    echo
    for f in "${UNCASHED[@]}"; do
      echo "  $f"
    done
    cat <<'MSG'

IN THIS REPOSITORY, THIS IS EXPECTED AND WILL NOT BE FIXED.

No git operation was permitted in the environment that produced this repository,
so the recipe below could not be executed: there was no way to commit the corpus
with no detector in the tree, and no way to record the sha of such a commit.

The ordering proof is therefore UNAVAILABLE here, not pending. It is not work
that remains to be done in this repository, it is a proof this environment
cannot produce. Do not soften `unavailable` to `pending` in FREEZE.json to make
it read like a to-do: they are different claims. See corpus/canary/FREEZE.json
for the full record, and the sibling agent-context-containment for the same
claim failing a different way, where a commit WAS recorded and was rejected
because the engine was already present in that tree.

WHAT IS STILL TRUE, and is what the project claims:

  - the 8 canary cases and the 16 extended cases have not changed
  - MANIFEST.sha256 covers their bytes, and CI verifies it before anything else
  - `shasum -a 256 -c corpus/canary/MANIFEST.sha256` checks that from the
    repository root with no tool from this project involved

WHAT IS NOT TRUE, and must not be written anywhere:

  - that the corpus is proven to predate the detector

THE LESSON, for the next repository:

  Authoring order leaves no trace. Commit order does. The corpus must be
  COMMITTED before the detector exists, not merely written first:

  1. Author the corpus and the spec it is written against.
  2. Commit them, with no detector in the tree.
  3. Record that sha and tag it, BEFORE writing packages/detect.
  4. Verify - this must exit NON-ZERO:

       git cat-file -e <sha>:packages/detect/src/compare.ts

DO NOT weaken this script to make it pass, and do not record a commit that does
not satisfy it. A freeze check that can be talked into agreeing is worth less
than no freeze check at all, because it looks like evidence.

NOTE: FREEZE.json is deliberately excluded from MANIFEST.sha256, so recording or
clearing a commit here never trips the drift check.
--------------------------------------------------------------------------------
MSG
  } >&2
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "verify-freeze: OK - $found freeze record(s) hold."
