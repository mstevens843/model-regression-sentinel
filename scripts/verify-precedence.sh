#!/usr/bin/env bash
#
# THE WEAKER PROOF, AND IT IS DELIBERATELY NOT CALLED A FREEZE.
#
# `verify-freeze.sh` checks the strong claim: the corpus existed at a commit where the detector did
# not. That proof is PERMANENTLY UNAVAILABLE in this repository and will never become available -
# `packages/detect/src/compare.ts` is present in the very first commit, so no commit that exists or
# ever will exist can satisfy it. Saying "not yet" about that would be false. It is not pending; the
# recipe for a repository that CAN cash it lives in corpus/*/FREEZE.json and applies to the next
# project, not this one.
#
# WHAT THIS CHECKS INSTEAD, and why it is worth having on its own. The load-bearing half of the
# freeze claim is not really "the corpus predates the detector" - it is "the corpus was not adjusted
# to fit the results". Those come apart: a corpus written after the detector but committed before
# anything was measured against it cannot have been tuned to flatter a measurement that did not
# exist yet. That IS checkable here, and it is checkable for every split added from now on.
#
#   For each split: the commit that introduced its case files must be an ANCESTOR of the commit that
#   introduced every recorded run whose caseIds include cases from that split.
#
# WHAT IT DOES NOT PROVE, stated so it cannot be quoted as the stronger thing:
#   - It says nothing about whether the corpus predates the DETECTOR. Only verify-freeze.sh does,
#     and here it cannot.
#   - A split with no results referencing it passes vacuously, and is reported as VACUOUS rather
#     than as PASS, because "nothing has been measured against these cases" and "these cases were
#     frozen before they were measured against" are different sentences.
#   - Anyone able to rewrite history can satisfy it. It is a claim about commit order, and commit
#     order is only as trustworthy as the history it is read from.
#
# EXIT CODES: 0 the precedence holds, 1 it does not, 2 the environment could not answer.

set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v git >/dev/null 2>&1; then
  echo "verify-precedence: git is not available, so commit order cannot be read." >&2
  exit 2
fi
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "verify-precedence: not a git repository, so there is no commit order to check." >&2
  exit 2
fi

# The commit that first introduced a path, or empty if it is untracked.
introduced() {
  git log --diff-filter=A --format=%H --reverse -- "$1" 2>/dev/null | head -1
}

fail=0
checked=0
vacuous=0

echo "verify-precedence: was each split committed before anything was measured against it?"
echo ""

for dir in corpus/*/; do
  split="$(basename "$dir")"

  # The split's own commit: the earliest introduction among its case files.
  split_commit=""
  for f in "$dir"*.json; do
    [ -f "$f" ] || continue
    case "$(basename "$f")" in
      FREEZE.json) continue ;;
    esac
    c="$(introduced "$f")"
    [ -n "$c" ] || continue
    if [ -z "$split_commit" ] || git merge-base --is-ancestor "$c" "$split_commit" 2>/dev/null; then
      split_commit="$c"
    fi
  done

  if [ -z "$split_commit" ]; then
    echo "  $split: UNTRACKED - no case file in this split is committed, so there is no order to read."
    fail=1
    continue
  fi

  # Every recorded run that contains at least one case id from this split.
  referencing=""
  for run in results/runs*/*.json; do
    [ -f "$run" ] || continue
    if node -e '
      const fs = require("node:fs");
      const [run, dir] = process.argv.slice(1);
      const snap = JSON.parse(fs.readFileSync(run, "utf8"));
      const ids = new Set(snap.caseIds ?? []);
      let hit = false;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json") || f === "FREEZE.json") continue;
        const body = JSON.parse(fs.readFileSync(dir + f, "utf8"));
        for (const c of body.cases ?? body) if (ids.has(String(c.id))) hit = true;
      }
      process.exit(hit ? 0 : 1);
    ' "$run" "$dir" 2>/dev/null; then
      referencing="$referencing $run"
    fi
  done

  if [ -z "$referencing" ]; then
    echo "  $split: VACUOUS - no recorded run references these cases, so nothing has been measured"
    echo "           against them and there is no precedence to establish. Not a pass."
    vacuous=$((vacuous + 1))
    continue
  fi

  ok=1
  pending=0
  ordered=0
  strict=0
  for run in $referencing; do
    run_commit="$(introduced "$run")"
    if [ -z "$run_commit" ]; then
      # NOT COMMITTED IS NOT OUT OF ORDER. A freshly collected run has no position in history yet,
      # and that is the ordinary state of a working tree straight after a collection. Failing here
      # would make this check red every time it is most likely to be read, which is how a check gets
      # ignored. It is reported as PENDING and does not fail - the claim is simply not yet available,
      # which is the same distinction this project draws everywhere between "not measured" and
      # "measured and bad".
      echo "  $split: PENDING - $run is not committed, so its order cannot be read yet."
      pending=$((pending + 1))
      continue
    fi
    if ! git merge-base --is-ancestor "$split_commit" "$run_commit" 2>/dev/null; then
      echo "  $split: FAIL - the cases were committed at $split_commit, which is NOT an ancestor of"
      echo "           $run_commit, where $run was committed. The corpus may have been adjusted"
      echo "           after seeing what it measured."
      ok=0
      continue
    fi
    ordered=$((ordered + 1))
    [ "$run_commit" = "$split_commit" ] || strict=$((strict + 1))
  done

  checked=$((checked + 1))
  if [ "$ok" -eq 1 ] && [ "$pending" -gt 0 ]; then
    # BOTH HALVES, because reporting only the pending ones erases what is already established. A
    # split can have some runs ordered and others uncommitted, and the honest line says so rather
    # than letting the newest artifact decide how the whole split reads.
    if [ "$ordered" -gt 0 ]; then
      echo "  $split: $ordered run(s) ordered ($strict strictly before), $pending pending."
    else
      echo "  $split: $pending run(s) pending, none yet ordered."
    fi
    echo "           Commit the pending runs and re-run to cash them."
  elif [ "$ok" -eq 1 ]; then
    # SAME-COMMIT IS THE WEAKEST WAY TO PASS, and it must not read the same as a strict ordering.
    # `git merge-base --is-ancestor X X` is true, so a corpus and the results measured against it
    # committed together satisfy "not after" without establishing "before". That is exactly the
    # situation here: this repository's first commit contains both. It is reported rather than
    # smoothed over, because "they were committed together" is a materially weaker sentence than
    # "the corpus was committed first" and only one of them is being claimed.
    same=1
    for run in $referencing; do
      run_commit="$(introduced "$run")"
      [ "$run_commit" = "$split_commit" ] || same=0
    done
    if [ "$same" -eq 1 ]; then
      echo "  $split: WEAK PASS - the cases and every run measuring them are in the SAME commit"
      echo "           (${split_commit:0:12}). Not after, but not demonstrably before either."
    else
      echo "  $split: PASS - committed at ${split_commit:0:12}, strictly before every run that measured it."
    fi
  else
    fail=1
  fi
done

echo ""
echo "verify-precedence: $checked split(s) checked, $vacuous vacuous."
echo ""
echo "THIS IS NOT THE FREEZE PROOF. It says the corpus was not adjusted after seeing what it"
echo "measured. It says NOTHING about whether the corpus predates the detector, which is the"
echo "stronger claim, is checked by scripts/verify-freeze.sh, and is PERMANENTLY UNAVAILABLE in"
echo "this repository: packages/detect/src/compare.ts exists in the first commit, so no commit that"
echo "will ever exist can satisfy it. See docs/FREEZE.md."

exit "$fail"
