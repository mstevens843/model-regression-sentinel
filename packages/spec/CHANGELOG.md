# @model-regression-sentinel/spec

## 0.2.0

### Minor Changes

- v0.2: a hardening pass, and the defects it found.

  The headline is a correctness defect rather than a feature. `compare` reported `NO_DRIFT` at exit 0
  when an arm produced no usable observation at all - a candidate run in which every call errored read
  as "nothing moved, and the suite had the power to have seen it move". That is the exact claim
  collapse this project exists to prevent, and every gate in the repository was green while it shipped.
  `whyItCouldNotLook` is now shared between `compare` and the watcher, `CompareResult` carries
  `couldNotLook`, and `exitCodeFor` returns 3. Scenario 13 and mutant `outageIsQuiet` pin it.

  Also in this release:

  - A mistyped `--alpha` silently turned a confirmed regression into exit 0, because `Number("bogus")`
    is NaN and `?? 0.05` cannot catch it. Every numeric flag is now validated and refused.
  - The tool's own printed next step named `--confirmation`, a flag nothing parses, which closed the
    SUSPECTED → CONFIRMED promotion path.
  - `run-study.mjs` would have overwritten the four recorded arms - 960 paid calls - with no existence
    check. It now refuses, and the cost estimate is priced from the study rather than from a pilot
    guess that was 2.3× high.
  - The power simulator computed a different statistic from the one the detector tests, so the
    reported MDE overstated the tool's own sensitivity.
  - Continuous MDEs rendered as "pp" when they are relative fractions.
  - `canonicalJson` silently flattened Dates, Maps and Sets to `{}`, so two different values hashed
    the same - in the module written to prevent exactly that.
  - The refusal lexicon missed a typographic apostrophe and scored "As an AI, the answer is HOLD." as
    a refusal.
  - Four silent under-validations in the JSON Schema subset, on a gating metric.
  - `generated-blocks.mjs --check` was wired into no gate at all, which is why the README claimed 267
    tests against 547 and 9 mutants against 11.
