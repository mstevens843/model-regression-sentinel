// What a provider is, and what one call records.
//
// Ported from `toolcall-risk-classifier/src/toolcall_risk/bench/providers/base.py`, which is the
// sibling that already solved this. The decisions worth restating, because each was learned rather
// than designed:
//
// THREE LATENCY FIGURES, NEVER COLLAPSED INTO ONE. `apiMs` is what the server reports and is a
// LOWER bound on a deployed call. `wallMs` includes process startup and is an UPPER bound.
// `clientMs` sits between them. The true deployed latency is somewhere in that interval and this
// project has not measured it, because it has no API key. Reporting a single number would mean
// picking whichever one flatters the argument, and a drift tool that shades its own latency numbers
// has no business flagging anyone else's.
//
// THE SERVED MODEL IS RECORDED ALONGSIDE THE REQUESTED ONE. This is the seed of the whole project.
// A pinned alias can route, and `modelServed` is where that shows up. Measured on this machine:
// requesting `haiku` served `claude-haiku-4-5-20251001`, a dated snapshot, while requesting `sonnet`
// served `claude-sonnet-5` with no date. Alias granularity is provider- and model-dependent and
// nothing may assume a dated id exists.
//
// THE KEY IS NEVER STORED, LOGGED OR SERIALIZED. It is read from the environment at call time and
// never enters a `ProviderResponse`, a snapshot or a report. The environment variable NAME is a
// constructor parameter rather than a constant, so it is configurable and testable, and so a test
// can prove the absent-key path without a key.
//
// ABSENCE IS A RETURN VALUE, NOT AN EXCEPTION. `available()` returns a reason string and an
// unavailable provider answers every call with `error: "SKIPPED: <reason>"`. A comparison that
// quietly vanishes when credentials are absent is worse than one that never existed, because a
// reader sees a table with a missing row and assumes it was not applicable.

import type { JsonValue } from "@model-regression-sentinel/spec";
import type { TokenSource } from "./metadata.js";

/** What the model is asked. Rendered from a case plus its prompt version. */
export interface CompletionRequest {
  readonly system: string;
  readonly user: string;
  /** When present, structured output is requested against this schema. */
  readonly jsonSchema?: JsonValue;
  readonly maxOutputTokens?: number;
}

/** Everything one call is allowed to tell us. */
export interface ProviderResponse {
  /** The raw output text, kept verbatim. Everything downstream re-derives from this. */
  readonly text: string;
  /**
   * Token counts, and a known limitation stated rather than papered over.
   *
   * These are `number` and not `number | null`, so ZERO AND "NOT EXPOSED" ARE THE SAME VALUE HERE.
   * A provider that omits its `usage` block entirely reads as a call that consumed nothing. The
   * capability fields below are `number | null` precisely because that distinction mattered there;
   * it was not made here, and widening it now would change the on-disk shape of every archived
   * snapshot, which the freeze discipline does not allow inside a minor version. Until then the
   * discriminator available to a reader is `error`, plus the fact that a real completion with a
   * non-empty `text` and zero input tokens is not a thing any of these providers produce.
   */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreateTokens: number;
  /** Server-reported call duration. A LOWER bound on a deployed call. */
  readonly apiMs: number;
  /** The client's own measure, between the two. */
  readonly clientMs: number;
  /** Wall time including process startup. An UPPER bound. */
  readonly wallMs: number;
  /** What the harness says it cost. Includes anything the harness itself injected. */
  readonly harnessCostUsd: number;
  /** The model identity the provider reports having served. May differ from what was requested. */
  readonly modelServed: string;
  /** A coarser identity, where the provider exposes one. Empty string when it does not. */
  readonly canonicalModel: string;
  /** Provider-reported capability facts. Null when not exposed. These can change silently. */
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  readonly serviceTier: string;
  readonly costBasis: string;
  readonly stopReason: string;
  /** Empty on success. `SKIPPED: <reason>` when the provider could not run at all. */
  readonly error: string;
}

/** A response for a call that could not be made. Every field zero, the reason carried. */
export const skipped = (reason: string): ProviderResponse => ({
  text: "",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  apiMs: 0,
  clientMs: 0,
  wallMs: 0,
  harnessCostUsd: 0,
  modelServed: "",
  canonicalModel: "",
  contextWindow: null,
  maxOutputTokens: null,
  serviceTier: "",
  costBasis: "",
  stopReason: "",
  error: `SKIPPED: ${reason}`,
});

/** Whether a provider can run, and if not, why. A reason a person can act on. */
export interface Availability {
  readonly ok: boolean;
  readonly reason: string;
}

export interface Provider {
  readonly name: string;
  /** What was ASKED for. The alias, if an alias was used. Never overwritten by what was served. */
  readonly model: string;
  /**
   * Where the calls go: `cli`, or the https origin of an endpoint. Never a full URL, which can carry
   * a query string and therefore a credential. Optional, and an absent value is recorded as
   * `unknown` rather than assumed, because "we did not capture the endpoint" and "there is no
   * endpoint" are different claims.
   */
  readonly endpoint?: string;
  /**
   * Where the token counts come from. A run counted by a CLI harness includes tokens that harness
   * injected; a run counted by a bare API does not. Comparing cost or output-token drift across that
   * boundary compares two different quantities, so the boundary is recorded rather than inferred.
   */
  readonly tokenSource?: TokenSource;
  /** The harness's own version, where there is a harness. A CLI upgrade can move behaviour. */
  readonly harnessVersion?: string;
  available(): Availability;
  complete(request: CompletionRequest): Promise<ProviderResponse>;
}
