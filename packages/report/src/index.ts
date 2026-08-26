// The public surface of @model-regression-sentinel/report.
//
// HAND-CURATED, AND `export *` IS FORBIDDEN HERE. A barrel built from `export *` publishes whatever
// happens to be exported today, which turns every internal rename into a breaking change for
// somebody and makes the package's API impossible to review in one place. This list IS the API: a
// name that is not on it is internal and may move without a major version. The same rule is
// enforced in @model-regression-sentinel/spec, /run and /detect, for the same reason.
//
// `./format.js` is deliberately absent. It holds the shared padding, wrapping and number-to-string
// decisions the three renderers agree on, and publishing it would invite a caller to build a fourth
// rendering that formats a percentage the same way by coincidence rather than by construction.
//
// Ordered so it reads top to bottom: the three renderings, then the ledger that decides, then the
// context a caller may attach, then the types.

// ---- the three renderings ------------------------------------------------------------------------
export { renderMarkdown } from "./markdown.js";
export { REPORT_SCHEMA_VERSION, renderJson } from "./json.js";
export { renderText } from "./text.js";

// ---- the exit-code ledger, where the decision is made ------------------------------------------------
export {
  ALL_GATE_STATUSES,
  AREA_COMPARABILITY,
  AREA_IDENTITY,
  AREA_METRIC,
  AREA_POWER,
  exitCodeFromGates,
  gatesFor,
  renderGates,
} from "./ledger.js";

// ---- the optional context any renderer will accept ---------------------------------------------------
export { DEFAULT_CONFIRM_COMMAND } from "./format.js";

// ---- types --------------------------------------------------------------------------------------------
export type { ReportContext } from "./format.js";
export type { MarkdownOptions } from "./markdown.js";
export type { JsonOptions } from "./json.js";
export type { GateRow, GateStatus } from "./ledger.js";
