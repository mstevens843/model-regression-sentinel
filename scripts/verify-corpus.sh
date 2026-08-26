#!/usr/bin/env bash
#
# Verify that the frozen corpus has not drifted, byte for byte.
#
# WHY THIS EXISTS. The corpus is the instrument that measures the provider. If it can be edited -
# deliberately, or by a formatter, or by an editor stripping a trailing newline - then every drift
# verdict measured against it is unfalsifiable, because the thing being measured and the thing doing
# the measuring are both under the same hand. That is worse here than in an ordinary eval: a drift
# detector whose corpus moved will report drift, and the report will be indistinguishable from the
# real thing.
#
# This is not hypothetical. In the sibling project `agent-context-containment`, before `corpus` was
# added to biome's ignore list, a routine `biome check --fix` reformatted the JSON whitespace of
# three frozen holdout files. The content was unaffected; the bytes were not. The manifest is what
# caught it. See that repository's docs/DEFECTS_FOUND.md section 5. This project put `corpus` in
# biome.json's ignore list on day one for that reason.
#
# IF THIS FAILS, DO NOT REGENERATE THE MANIFEST TO MAKE IT PASS. That is the one move that turns a
# working integrity check into decoration. Find out what wrote to the file first.

set -euo pipefail

cd "$(dirname "$0")/.."

if command -v shasum >/dev/null 2>&1; then
  CHECK=(shasum -a 256 -c)
elif command -v sha256sum >/dev/null 2>&1; then
  CHECK=(sha256sum -c)
else
  echo "verify-corpus: neither shasum nor sha256sum is available." >&2
  exit 2
fi

fail=0
found=0
for manifest in corpus/*/MANIFEST.sha256; do
  [ -f "$manifest" ] || continue
  found=$((found + 1))
  echo "verify-corpus: checking $manifest"
  if ! "${CHECK[@]}" "$manifest"; then
    fail=1
  fi
done

if [ "$found" -eq 0 ]; then
  echo "verify-corpus: no corpus manifest found. Run this from the repository root." >&2
  exit 2
fi

if [ "$fail" -eq 0 ]; then
  n=$(cat corpus/*/MANIFEST.sha256 | grep -c . || true)
  echo "verify-corpus: OK - $n corpus file(s) match their frozen manifests."
  exit 0
fi

cat >&2 <<'MSG'

--------------------------------------------------------------------------------
CORPUS DRIFT: the frozen corpus no longer matches its manifest.
--------------------------------------------------------------------------------

The corpus is the instrument that measures the provider. If it changes, every
drift verdict measured against it is worth less, and possibly worth nothing. A
detector whose own corpus moved will report drift that is not there.

Do NOT regenerate the manifest to make this pass. Work out what wrote to the
file:

  1. A formatter or linter?  `corpus` is in biome.json's ignore list; check that
     it is still there, and check any editor-on-save formatting.
  2. A deliberate edit?  The corpus is frozen. If a case genuinely needs to
     change, that is a new corpus version: cut one, keep the old results
     published beside it, and say so.
  3. A whitespace-only change?  The content may be intact and the bytes are
     still not. Both claims matter and they are not the same claim.

Only regenerate the manifest once you know which of those it was, with
`pnpm write:manifest`, and record it in RESULTS.md.
--------------------------------------------------------------------------------
MSG
exit 1
