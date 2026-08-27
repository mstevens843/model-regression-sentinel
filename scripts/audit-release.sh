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
# Exit 0 means every gate is green and both negative controls fired.

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
  echo "All gates green, and both negative controls fired."
else
  echo "One or more gates failed. Nothing is releasable."
fi
exit "$fail"
