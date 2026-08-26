#!/usr/bin/env bash
#
# Record a commit hash into corpus/<split>/FREEZE.json.
#
# WHAT THIS DOES AND DOES NOT DO, because the distinction is the whole point:
#
#   It writes metadata. That is all. Recording a hash does not make the corpus predate the
#   detector - it asserts that it does, and the assertion is worth exactly as much as the commit
#   behind it.
#
#   `verify:freeze` is what checks the claim, by asking git whether packages/detect/src/compare.ts
#   existed at that commit. Run it immediately after this, and if it fails, the hash was wrong. Do
#   not adjust either script to make it pass.
#
# Deliberately separate from verify-freeze.sh: one records, one checks. A script that did both would
# be a script that can be talked into agreeing with itself.
#
# WHY THIS ALSO WRITES `state`, which the sibling's version does not. `checkFreeze` in
# packages/spec/src/freeze.ts enforces one rule above all others: the state and the commit must not
# contradict each other. `cashed` with no commit is a FREEZE_STATE_COMMIT_DISAGREE violation, and so
# is `unavailable` or `pending` WITH a commit present. A script that wrote frozenAtCommit alone
# would therefore leave the record invalid at the exact moment it succeeded, and the validator this
# project added over the sibling would start rejecting the file the discipline exists to protect. So
# recording a commit flips `unavailable` or `pending` to `cashed` in the same write. `cashed` and
# `attempted_and_failed` are left alone: both are legal with a commit, and overwriting a record of a
# rejected attempt is a decision, not a fix.
#
# WHAT IT DOES NOT WRITE is the prose. whatIsProven, whatIsNotProven and reason are left exactly as
# they were, and the closing message says so. A script that edits the honesty prose is a script that
# makes a claim on your behalf.
#
# It also does not carry over the sibling's undeclared `verify` field. FreezeRecord in
# packages/spec/src/freeze.ts is the schema now, and freeze records with field sets nobody declared
# are the precise defect that file's header names. The verify command is printed to the terminal
# instead, where it is read by the person who has to run it.
#
# Does NOT touch corpus/<split>/MANIFEST.sha256. FREEZE.json is excluded from the manifest precisely
# so this can run without tripping the drift check.

set -euo pipefail

cd "$(dirname "$0")/.."

ENGINE="packages/detect/src/compare.ts"
SPLIT="${1:-}"
SHA="${2:-}"

# The splits are read off the filesystem rather than hardcoded, so this cannot go stale against a
# corpus that grew a third split.
splits() {
  for d in corpus/*/FREEZE.json; do
    [ -f "$d" ] || continue
    echo "  $(basename "$(dirname "$d")")"
  done
}

if [ -z "$SPLIT" ] || [ -z "$SHA" ]; then
  {
    echo "usage: pnpm record:freeze <split> <commit-sha>"
    echo
    echo "Splits in this repository:"
    splits
    cat <<'MSG'

Find the commit where the corpus exists and the detector does not:

  git log --oneline --diff-filter=A -- corpus/canary

Confirm the detector is absent there. THIS MUST FAIL:

  git cat-file -e <sha>:packages/detect/src/compare.ts

Then record it and verify:

  pnpm record:freeze canary <sha>
  pnpm verify:freeze
  git tag -s corpus-canary-v1 <sha>
MSG
  } >&2
  exit 2
fi

# Validated as a plain lowercase name before it is used to build a path or handed to node. A split
# name is an identifier, not user prose, and this is the only argument that reaches the filesystem.
if ! printf '%s' "$SPLIT" | grep -Eq '^[a-z][a-z0-9-]*$'; then
  echo "record-freeze: \"$SPLIT\" is not a split name." >&2
  echo "Splits in this repository:" >&2
  splits >&2
  exit 2
fi

FREEZE="corpus/$SPLIT/FREEZE.json"

if [ ! -f "$FREEZE" ]; then
  echo "record-freeze: $FREEZE not found." >&2
  echo "Either \"$SPLIT\" is not a split in this repository, or this was not run from the root." >&2
  echo "Splits in this repository:" >&2
  splits >&2
  exit 2
fi

if ! printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "record-freeze: \"$SHA\" is not a 40-character lowercase hex sha." >&2
  echo "Use the full hash, not an abbreviation - an abbreviation can become ambiguous later." >&2
  exit 2
fi

EXISTING=$(node -e '
  const f = require("fs");
  const j = JSON.parse(f.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(j.frozenAtCommit ?? ""));
' "$FREEZE")

if [ -n "$EXISTING" ] && [ "$EXISTING" != "null" ] && [ "$EXISTING" != "$SHA" ]; then
  echo "record-freeze: $FREEZE is already recorded as $EXISTING." >&2
  echo "Overwriting a freeze point is a decision, not a fix. Clear it by hand if you mean it." >&2
  exit 1
fi

STATE=$(node -e '
  const f = require("fs");
  const p = process.argv[1];
  const sha = process.argv[2];
  const j = JSON.parse(f.readFileSync(p, "utf8"));
  j.frozenAtCommit = sha;
  // The one field checkFreeze would otherwise reject. See the header for the rule.
  if (j.state === "unavailable" || j.state === "pending") j.state = "cashed";
  f.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  process.stdout.write(String(j.state));
' "$FREEZE" "$SHA")

echo "record-freeze: recorded $SHA in $FREEZE"
echo "record-freeze: state is now \"$STATE\""
echo
echo "The prose was NOT rewritten. whatIsProven, whatIsNotProven and reason still describe the"
echo "state this record was in before this ran, and only a human should change what they say."
echo
echo "This wrote metadata and proved nothing. Verify it now:"
echo
echo "    git cat-file -e $SHA:$ENGINE   # MUST exit non-zero"
echo "    pnpm verify:freeze"
echo
echo "If that fails, the hash is wrong. Fix the hash, not the script."
