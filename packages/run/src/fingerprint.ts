// The provider identity fingerprint: drift detection with no statistics in it at all.
//
// Everything else in this project is an inference problem. This is not. If the identity a provider
// reports for a pinned alias changes, that is a FACT, it has no p-value, and it cannot be a false
// positive. It is also nearly free to check, which is why the watcher checks it on every tick while
// the statistical machinery needs a whole round of replicates.
//
// WHAT IS IN THE FINGERPRINT, and why each field earns its place. Measured on this machine:
//
//   requested        `sonnet`                  `haiku`
//   resolvedKey      claude-sonnet-5           claude-haiku-4-5-20251001   <- a DATED snapshot
//   canonicalModel   claude-sonnet-5           claude-haiku-4-5
//   contextWindow    1000000                   200000
//   maxOutputTokens  64000                     (not reported)
//
// The `haiku` alias exposes a dated snapshot and the `sonnet` alias does not, which is the single
// most useful thing this probe found: ALIAS RESOLUTION GRANULARITY IS PROVIDER- AND MODEL-DEPENDENT,
// and a tool that assumes a dated id exists will report "no identity change" for a provider that
// simply never had one to show. So a null field is recorded as null and never as a default, and the
// report says which fields the provider declined to expose rather than implying they were stable.
//
// contextWindow and maxOutputTokens are in here because they are CAPABILITY facts a provider can
// change under a fixed name, and a context window that halved overnight is a breaking change that
// no behavioral metric would attribute correctly.
//
// WHAT A FINGERPRINT CHANGE DOES NOT MEAN: that behavior changed. A vendor can re-tag the same
// weights. So this is reported in its own category, never as a regression on its own, and it raises
// the priority of any concurrent behavioral finding rather than substituting for one.

import { canonicalHash } from "@model-regression-sentinel/spec";
import type { ProviderResponse } from "./types.js";

export interface ProviderFingerprint {
  /** What was asked for. An alias stays an alias here. */
  readonly requestedModel: string;
  /** What the provider says it served. */
  readonly resolvedModel: string;
  /** A coarser identity where one is exposed. Empty string when the provider does not expose one. */
  readonly canonicalModel: string;
  readonly provider: string;
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  readonly costBasis: string;
  readonly serviceTier: string;
  /** sha256 over the canonical form of everything above. The thing that is compared. */
  readonly sha256: string;
}

export function fingerprintOf(
  provider: string,
  requestedModel: string,
  response: ProviderResponse,
): ProviderFingerprint {
  const body = {
    requestedModel,
    resolvedModel: response.modelServed,
    canonicalModel: response.canonicalModel,
    provider,
    contextWindow: response.contextWindow,
    maxOutputTokens: response.maxOutputTokens,
    costBasis: response.costBasis,
    serviceTier: response.serviceTier,
  };
  return { ...body, sha256: canonicalHash(body) };
}

/** One field that moved. */
export interface FingerprintChange {
  readonly field: string;
  readonly before: string;
  readonly after: string;
}

/**
 * What changed between two fingerprints.
 *
 * Returns the fields rather than a boolean, because "the identity changed" is not actionable and
 * "the context window went from 1000000 to 200000" is.
 */
export function fingerprintDiff(
  before: ProviderFingerprint,
  after: ProviderFingerprint,
): readonly FingerprintChange[] {
  const fields = [
    "requestedModel",
    "resolvedModel",
    "canonicalModel",
    "provider",
    "contextWindow",
    "maxOutputTokens",
    "costBasis",
    "serviceTier",
  ] as const;
  const out: FingerprintChange[] = [];
  for (const field of fields) {
    const a = before[field];
    const b = after[field];
    if (a !== b) out.push({ field, before: String(a), after: String(b) });
  }
  return out;
}

/** Fields the provider declined to expose, so a report can say so rather than implying stability. */
export const undisclosedFields = (f: ProviderFingerprint): readonly string[] => {
  const out: string[] = [];
  if (f.contextWindow === null) out.push("contextWindow");
  if (f.maxOutputTokens === null) out.push("maxOutputTokens");
  if (f.canonicalModel === "") out.push("canonicalModel");
  if (f.serviceTier === "") out.push("serviceTier");
  return out;
};
