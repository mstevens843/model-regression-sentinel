// Cost arithmetic, from a dated rate card, with the counterfactual kept separate from the measured.
//
// Ported from `toolcall-risk-classifier/src/toolcall_risk/bench/cost.py`, including the rule that
// matters most:
//
// TWO NUMBERS, ALWAYS BOTH, NEVER MERGED.
//
//   harnessMeasured   what the harness reports it cost. For the `claude` CLI provider this includes
//                     tokens the CLI injects that a bare API integration would never send. It is an
//                     UPPER bound and it is a real, measured number.
//   bareApiComputed   this project's own prompt and completion tokens against the published rate
//                     card. A LOWER bound. It is COMPUTED, NOT MEASURED, and every table that
//                     prints it says so in the header.
//
// MEASURED ON THIS MACHINE, and the gap is not small. One `claude -p` call with no flags cost
// $0.451 and reported 112,748 cache-creation tokens, almost all of them MCP tool schemas belonging
// to the harness rather than to this project. The same call with `--tools "" --strict-mcp-config
// --system-prompt` cost $0.0132 cold and $0.00084 once the prompt cache was warm. A 500-fold
// difference in the cost of an identical question is why the harness overhead is reported rather
// than absorbed, and why the canary provider argv strips everything it can.
//
// THE RATE CARD IS DATED AND WILL GO STALE. That is a normal property of a rate card and not a
// defect, but it is a specific hazard for THIS project: a vendor reprices, `costUsd` moves for every
// case at once, and a naive detector calls it drift. That is why cost is not a gating metric. See
// GATING_METRICS in @model-regression-sentinel/spec.

export const RATE_CARD_DATE = "2026-06-24";
export const RATE_CARD_SOURCE = "Anthropic published list pricing, USD per million tokens";

/** [input, output] USD per million tokens. */
export const RATES: Readonly<Record<string, readonly [number, number]>> = {
  "claude-opus-5": [5.0, 25.0],
  "claude-sonnet-5": [2.0, 10.0],
  "claude-haiku-4-5": [1.0, 5.0],
};

export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Map a served model string onto a rate-card key by longest prefix.
 *
 * Prefix matching rather than exact, because a served model may carry a dated suffix that the rate
 * card does not: measured on this machine, requesting `haiku` served `claude-haiku-4-5-20251001`
 * while the rate card keys on `claude-haiku-4-5`. LONGEST prefix rather than first, so that adding
 * a more specific key to the table later cannot be silently shadowed by a shorter one.
 */
export function canonicalRateKey(served: string): string {
  let best = "";
  for (const key of Object.keys(RATES)) {
    if (served.startsWith(key) && key.length > best.length) best = key;
  }
  return best === "" ? served : best;
}

export interface CostBounds {
  readonly model: string;
  readonly n: number;
  readonly meanInputTokens: number;
  readonly meanOutputTokens: number;
  readonly meanCacheReadTokens: number;
  readonly meanCacheCreateTokens: number;
  /** Measured, an upper bound: includes whatever the harness injected. */
  readonly harnessUsdPerCall: number;
  /** Computed from the rate card, a lower bound. NOT measured. */
  readonly bareApiUsdPerCall: number;
  readonly rateCardDate: string;
  /** True when the served model is not in the rate card, so the bare-API figure is meaningless. */
  readonly rateUnknown: boolean;
}

export interface CostInput {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreateTokens: number;
  readonly harnessCostUsd: number;
}

export function summariseCost(model: string, rows: readonly CostInput[]): CostBounds {
  const n = Math.max(1, rows.length);
  const key = canonicalRateKey(model);
  const rate = RATES[key];
  const [rateIn, rateOut] = rate ?? [0, 0];

  const mean = (pick: (r: CostInput) => number): number =>
    rows.reduce((total, r) => total + pick(r), 0) / n;

  const meanInput = mean((r) => r.inputTokens);
  const meanOutput = mean((r) => r.outputTokens);

  return {
    model: key,
    n: rows.length,
    meanInputTokens: meanInput,
    meanOutputTokens: meanOutput,
    meanCacheReadTokens: mean((r) => r.cacheReadTokens),
    meanCacheCreateTokens: mean((r) => r.cacheCreateTokens),
    harnessUsdPerCall: mean((r) => r.harnessCostUsd),
    bareApiUsdPerCall: (meanInput / 1e6) * rateIn + (meanOutput / 1e6) * rateOut,
    rateCardDate: RATE_CARD_DATE,
    rateUnknown: rate === undefined,
  };
}
