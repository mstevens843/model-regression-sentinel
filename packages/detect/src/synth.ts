// Building synthetic runs with a KNOWN answer, so the detector can be graded.
//
// A detector can only be validated against data whose truth is known, and no real provider run
// comes with that. So the calibration scenarios manufacture runs from stated per-case rates: an A/A
// pair is two draws from the same rates, and an injected-drift pair is two draws from rates that
// differ by a stated amount. What is being measured is then the detector's error rate against
// ground truth rather than its agreement with itself.
//
// WHAT THIS DOES NOT ESTABLISH, said here so it is not claimed elsewhere. These are Bernoulli and
// log-normal draws. A real provider's nondeterminism has structure that no parametric family
// captures: outputs cluster into a few lexical modes, latency has a fat tail whose shape depends on
// the provider's load, and a genuine model update changes several metrics at once and in correlated
// ways. So a false-positive rate measured here is a lower bound on the real one, and the A/A study
// against RECORDED outputs in `results/` is the stronger evidence. Both are reported and neither is
// presented as the other.
//
// The distributions are chosen from the pilot measured on this machine rather than from taste:
// output tokens are log-normal with a CV near 18 percent, and latency is log-normal with a heavy
// component reproducing the one-in-eight sample at 3.57 times the median.

import type {
  ProviderMetadata,
  ProviderResponse,
  RunRecord,
  RunSnapshot,
} from "@model-regression-sentinel/run";
import { corpusDigestOf } from "@model-regression-sentinel/run";
import { type Rng, binomial } from "./rng.js";

export interface SynthCase {
  readonly caseId: string;
  /** Probability the graders pass on any one draw. */
  readonly passRate: number;
  readonly medianOutputTokens: number;
  readonly medianLatencyMs: number;
  /** Multiplier applied to one replicate in ten, reproducing the measured latency tail. */
  readonly latencyTail?: number;
}

export interface SynthOptions {
  readonly label: string;
  readonly replicates: number;
  readonly rng: Rng;
  readonly capturedAt?: string;
  readonly corpusDigest?: string;
  readonly requestedModel?: string;
  readonly resolvedModel?: string;
  /** Multiplies every case's output-token median. For token-drift scenarios. */
  readonly tokenScale?: number;
  /** Multiplies every case's latency median. For latency scenarios. */
  readonly latencyScale?: number;
  /**
   * Provider metadata to attach. Present so a scenario can move metadata while holding behaviour
   * perfectly still, which is the only way to test that the two are reported apart.
   */
  readonly metadata?: ProviderMetadata;
  /**
   * Fail this fraction of calls with the given error string. 1 fails every call.
   *
   * Added because there was no way to construct the degenerate arm at all, and that is why the
   * degenerate arm went untested: an outage is the one condition a synthetic generator will never
   * produce by accident. See scenario 13.
   */
  readonly errorRate?: number;
  readonly errorText?: string;
}

const PASS = "PASS";
const FAIL = "FAIL";

/** A log-normal draw with the given median and log-scale sigma, via Box-Muller on the seeded rng. */
function logNormal(rng: Rng, medianValue: number, sigma: number): number {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return medianValue * Math.exp(sigma * z);
}

export function synthSnapshot(cases: readonly SynthCase[], options: SynthOptions): RunSnapshot {
  const records: RunRecord[] = [];
  const tokenScale = options.tokenScale ?? 1;
  const latencyScale = options.latencyScale ?? 1;

  for (const c of cases) {
    for (let r = 0; r < options.replicates; r += 1) {
      const errored =
        options.errorRate !== undefined && binomial(options.rng, 1, options.errorRate) === 1;
      const passed = binomial(options.rng, 1, c.passRate) === 1;
      const tail = c.latencyTail !== undefined && options.rng() < 0.125 ? c.latencyTail : 1;
      const response: ProviderResponse = {
        // An errored call carries no text. `extractMetrics` drops it from every sample, which is
        // the behaviour under test: dropped-and-counted, never scored as a failure.
        text: errored ? "" : passed ? PASS : FAIL,
        inputTokens: 40,
        outputTokens: Math.round(logNormal(options.rng, c.medianOutputTokens * tokenScale, 0.18)),
        cacheReadTokens: 3301,
        cacheCreateTokens: 0,
        apiMs: logNormal(options.rng, c.medianLatencyMs * latencyScale, 0.12) * tail,
        clientMs: 0,
        wallMs: 0,
        harnessCostUsd: 0.00084,
        modelServed: options.resolvedModel ?? "synthetic-model-1",
        canonicalModel: options.resolvedModel ?? "synthetic-model-1",
        contextWindow: 200000,
        maxOutputTokens: 64000,
        serviceTier: "standard",
        costBasis: "list",
        stopReason: errored ? "" : "end_turn",
        error: errored ? (options.errorText ?? "ECONNREFUSED") : "",
      };
      records.push({
        caseId: c.caseId,
        replicate: r,
        promptId: "terse-v1",
        promptSha256: "synthetic",
        requestSha256: `req-${c.caseId}`,
        response,
      });
    }
  }

  return {
    schemaVersion: 1,
    label: options.label,
    capturedAt: options.capturedAt ?? "2026-08-26T00:00:00.000Z",
    provider: "synthetic",
    requestedModel: options.requestedModel ?? "synthetic-alias",
    splits: ["canary"],
    replicates: options.replicates,
    concurrency: 1,
    caseIds: cases.map((c) => c.caseId),
    // COMPUTED FROM THE CASES, not a literal. It was `"synthetic-digest"` - a constant that matched
    // nothing, including the cases the snapshot was built from. That was invisible while `compare`
    // only checked the two snapshots against each other, and became a fifteen-test failure the
    // moment it also checked them against the case list: every synthetic artifact in the suite was
    // internally inconsistent, and the tests passed because nothing looked.
    //
    // A fixture that cannot survive the checks the real artifacts survive is a fixture that tests a
    // weaker thing than it claims to. `corpusDigest` is still overridable, which is what scenario 08
    // uses to build two genuinely different corpora.
    corpusDigest: options.corpusDigest ?? corpusDigestOf(synthEvalCases(cases)),
    fingerprint: {
      requestedModel: options.requestedModel ?? "synthetic-alias",
      resolvedModel: options.resolvedModel ?? "synthetic-model-1",
      canonicalModel: options.resolvedModel ?? "synthetic-model-1",
      provider: "synthetic",
      contextWindow: 200000,
      maxOutputTokens: 64000,
      costBasis: "list",
      serviceTier: "standard",
      sha256: `fp-${options.resolvedModel ?? "synthetic-model-1"}`,
    },
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    records,
    errorCount: records.filter((r) => r.response.error !== "").length,
    cost: {
      model: "synthetic",
      n: records.length,
      meanInputTokens: 40,
      meanOutputTokens: 0,
      meanCacheReadTokens: 3301,
      meanCacheCreateTokens: 0,
      harnessUsdPerCall: 0.00084,
      bareApiUsdPerCall: 0,
      rateCardDate: "2026-06-24",
      rateUnknown: true,
    },
  };
}

/** A synthetic case set matching the shape of the real corpus: mostly easy, some genuinely uncertain. */
export function synthCases(n: number, rates?: readonly number[]): readonly SynthCase[] {
  const out: SynthCase[] = [];
  for (let i = 0; i < n; i += 1) {
    // Reproduces the measured mix: most constrained cases are near-deterministic, a minority are
    // ambiguous. A uniform 0.9 everywhere would be an easier suite than the real one.
    const fallback = i % 4 === 0 ? 0.75 : i % 7 === 0 ? 0.9 : 1.0;
    out.push({
      caseId: `syn-c-${String(i + 1).padStart(3, "0")}`,
      passRate: rates?.[i] ?? fallback,
      medianOutputTokens: i % 5 === 0 ? 1100 : 70,
      medianLatencyMs: i % 5 === 0 ? 13000 : 1400,
      latencyTail: 3.57,
    });
  }
  return out;
}

/** The EvalCase stubs the detector needs to grade a synthetic run. */
export function synthEvalCases(
  cases: readonly SynthCase[],
): readonly import("@model-regression-sentinel/spec").EvalCase[] {
  return cases.map((c) => ({
    schemaVersion: 1 as const,
    id: c.caseId as unknown as import("@model-regression-sentinel/spec").CaseId,
    split: "canary" as const,
    archetype: "constrained_categorical" as const,
    title: c.caseId,
    promptId: "terse-v1" as unknown as import("@model-regression-sentinel/spec").PromptId,
    input: { system: "", user: c.caseId },
    graders: [{ kind: "exact" as const, expected: PASS }],
    requiredSignals: ["quality" as const],
    detectionLimit: null,
    provenance: { kind: "original" as const },
    authoredAt: "2026-08-26",
    note: "synthetic",
  }));
}
