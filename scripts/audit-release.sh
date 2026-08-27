#!/usr/bin/env bash
#
# The release gate, and the two checks in it that are inverted.
#
# Most of this is the ordinary sequence: lint, typecheck, build, test, corpus integrity. The
# interesting part is that TWO GATES PASS ONLY WHEN SOMETHING FAILS, and both exist because a check
# that can only ever succeed proves nothing about the thing it checks.
#
#   `verify:freeze` MUST exit non-zero. The ordering proof is unavailable in this repository and is
#   recorded as such. If it ever starts passing, either someone cashed the freeze properly, in which
#   case this script should be updated deliberately, or someone weakened the check to make a red
#   mark go away, which is the failure this inversion exists to catch. The sibling
#   `agent-context-containment/scripts/audit-release.sh` does exactly this, for exactly this reason.
#
#   The corpus drift check MUST fire on a corrupted corpus. A manifest verifier that has never been
#   shown to reject anything is decoration, so this corrupts a copy, confirms the rejection, and
#   restores the original before it looks at the verdict.
#
# Exit 0 means every gate is green and every negative control fired. The count is derived at the
# end rather than written here, because a hand-maintained count of checks is the same class of stale
# claim as a hand-maintained count of tests, and this file gained a third control without the
# closing line noticing.

set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
step() {
  echo
  echo "-- $1"
}
pass() { echo "  PASS - $1"; }
bad() {
  echo "  FAIL - $1"
  fail=1
}

# Counted from the step labels themselves, so it cannot disagree with what ran.
controls=$(grep -c '^step "[0-9a-z]*\. NEGATIVE CONTROL' "$0")

step "1. lint, typecheck, build, test"
if pnpm -s lint >/dev/null 2>&1; then pass "lint"; else bad "lint"; fi
if pnpm -s typecheck >/dev/null 2>&1; then pass "typecheck"; else bad "typecheck"; fi
if pnpm -s build >/dev/null 2>&1; then pass "build"; else bad "build"; fi
if pnpm -s test >/dev/null 2>&1; then pass "test"; else bad "test"; fi

step "2. the frozen corpus matches its manifest"
if bash scripts/verify-corpus.sh >/dev/null 2>&1; then pass "corpus integrity"; else bad "corpus integrity"; fi

step "3. the manifest covers what is on disk"
if node scripts/write-manifest.mjs --check >/dev/null 2>&1; then
  pass "no untracked or stale corpus file"
else
  bad "the manifest and the corpus disagree"
fi

step "3b. the case-composition table matches the corpus"
if node scripts/case-composition.mjs --check >/dev/null 2>&1; then
  pass "docs/CORPUS.md is current"
else
  bad "docs/CORPUS.md and the corpus disagree; run pnpm docs:composition"
fi

step "3c. every generated block matches the artifact it describes"
if node scripts/generated-blocks.mjs --check >/dev/null 2>&1; then
  pass "generated blocks are current"
else
  bad "a generated block is stale; run pnpm blocks:write"
fi

step "3d. the recorded test count matches the suite"
if node scripts/test-counts.mjs --check >/dev/null 2>&1; then
  pass "results/tests.json describes this suite"
else
  bad "results/tests.json is stale; run pnpm test:count"
fi

# THE GAP THIS CLOSES, and why step 3c could not close it. `generated-blocks.mjs --check` compares
# each BLOCK against the ARTIFACT it reads. It cannot see that the artifact itself went stale:
# results/tests.json said 579 while the green suite contained 599, the block matched the artifact
# exactly, and every gate above passed. Step 3d enumerates the suite with `vitest list` - which
# collects without executing, so it counts the tests generated in loops too - and compares. Five
# seconds, and exact: measured package by package against a full run, every count identical.
step "3e. NEGATIVE CONTROL: the test-count check must reject a stale count"
scratch_counts=$(mktemp -d)
cp results/tests.json "$scratch_counts/tests.json"
node -e '
  const fs = require("node:fs");
  const j = JSON.parse(fs.readFileSync("results/tests.json", "utf8"));
  j.packages[0].tests += 1;
  j.totalTests += 1;
  fs.writeFileSync("results/tests.json", JSON.stringify(j, null, 2) + "\n");
'
set +e
node scripts/test-counts.mjs --check >/dev/null 2>&1
counts_code=$?
set -e
cp "$scratch_counts/tests.json" results/tests.json
rm -rf "$scratch_counts"
if [ "$counts_code" -eq 0 ]; then
  bad "a corrupted test count passed the check, so the check cannot detect the drift it exists to detect"
else
  pass "a stale test count was rejected (exit $counts_code), and the original was restored"
fi
if ! node scripts/test-counts.mjs --check >/dev/null 2>&1; then
  bad "the restore did not work and results/tests.json is now wrong"
fi

step "4. NEGATIVE CONTROL: the drift check must reject a corrupted corpus"
target="corpus/canary/outbox.json"
backup="$(mktemp)"
cp "$target" "$backup"
printf ' ' >>"$target"
set +e
bash scripts/verify-corpus.sh >/dev/null 2>&1
code=$?
set -e
cp "$backup" "$target"
rm -f "$backup"
if [ "$code" -eq 0 ]; then
  bad "a corrupted corpus passed the drift check, so the check cannot detect what it claims to"
else
  pass "a corrupted corpus was rejected (exit $code), and the original was restored"
fi
if ! bash scripts/verify-corpus.sh >/dev/null 2>&1; then
  bad "the restore did not work and the corpus is now dirty"
fi

step "5. NEGATIVE CONTROL: the freeze claim is still unavailable, not pending"
set +e
bash scripts/verify-freeze.sh >/dev/null 2>&1
code=$?
set -e
if [ "$code" -eq 0 ]; then
  bad "verify:freeze passed. The ordering proof is supposed to be unobtainable here. Either it was cashed properly and this script needs updating deliberately, or the check was weakened."
else
  pass "verify:freeze exits $code, by design"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "All gates green, and all ${controls} negative controls fired."
else
  echo "One or more gates failed. Nothing is releasable."
fi
exit "$fail"
