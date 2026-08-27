// Provider metadata, and the reason two absences are not a fact.
//
// v0.1 recorded a provider fingerprint: the requested alias, the resolved identity, the context
// window, a couple of capability facts. It worked and it had one hole that this file exists to
// close, plus one gap.
//
// THE HOLE. Every optional field was `number | null`, and `null` meant two completely different
// things: "the provider was asked and does not report this" and "nobody ever found out". Diffing two
// nulls produced "unchanged", which reads as evidence of stability and is nothing of the kind. Two
// absences are two absences. A provider that stopped reporting its context window, compared against
// an older run that never captured one, would show a clean diff on the one field that moved.
//
// So a metadata field is a `MetaValue` with three states, and the comparison below refuses to treat
// the absent ones as agreement:
//
//   `value`        we have it, and it is this
//   `not_exposed`  the provider was asked and does not report it. A fact about the provider.
//   `unknown`      we did not or could not determine it. A fact about US, and never evidence.
//
// THE GAP. A fingerprint described the MODEL and said nothing about the path taken to reach it. A
// resolved model can hold still while the endpoint moves from a local CLI to a hosted API, while the
// adapter in this repository is rewritten, or while the token counts start coming from somewhere
// else. Every one of those changes what the numbers mean, and none of them is a model change. They
// are captured here and reported in their own category.
//
// METADATA DRIFT IS NOT QUALITY DRIFT AND MUST NEVER BE SCORED AS ONE. It carries no p-value: a
// field either moved or it did not, and there is no sampling involved. What it does is raise the
// priority of a concurrent behavioural finding, and stand on its own when behaviour is quiet.

import { canonicalHash } from "@model-regression-sentinel/spec";
import type { ProviderResponse } from "./types.js";

/** A field we might know, might have been refused, or might simply never have looked up. */
export type MetaValue =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "not_exposed" }
  | { readonly kind: "unknown" };

export const metaValue = (v: string | number | null | undefined): MetaValue =>
  v === null || v === undefined || v === ""
    ? { kind: "not_exposed" }
    : { kind: "value", value: String(v) };

export const metaUnknown = (): MetaValue => ({ kind: "unknown" });

/** For a table. `not_exposed` and `unknown` must never render the same way. */
export const renderMeta = (m: MetaValue): string =>
  m.kind === "value" ? m.value : m.kind === "not_exposed" ? "(not exposed)" : "(unknown)";

/**
 * Where the token counts came from.
 *
 * Not decoration. A run whose counts came from a CLI harness includes tokens that harness injected,
 * and a run whose counts came from a bare API does not. Comparing cost or output-token drift across
 * that boundary compares two different quantities, and this field is what makes the boundary
 * visible instead of silent.
 */
export type TokenSource = "cli_usage" | "anthropic_usage" | "openai_usage" | "replayed" | "none";

export interface ProviderMetadata {
  readonly schemaVersion: 1;
  /** What was ASKED for. An alias stays an alias: that is the whole subject of this project. */
  readonly requestedModel: MetaValue;
  /** What the provider says it served. The dated snapshot, where one is exposed. */
  readonly resolvedModel: MetaValue;
  /** A coarser identity, where one is exposed. */
  readonly canonicalModel: MetaValue;
  readonly contextWindow: MetaValue;
  readonly maxOutputTokens: MetaValue;
  readonly serviceTier: MetaValue;
  readonly costBasis: MetaValue;
  /** `cli`, or the https origin of the endpoint. Never the full URL, which can carry a query. */
  readonly endpoint: MetaValue;
  /** Which adapter in THIS repository produced the row, and at what version. */
  readonly adapter: MetaValue;
  readonly adapterVersion: MetaValue;
  /** The harness's own version, where the harness reports one. `claude --version`, for instance. */
  readonly harnessVersion: MetaValue;
  readonly tokenSource: TokenSource;
  readonly observedAt: string;
  /** sha256 over every field above except `observedAt`. Two identical setups hash the same. */
  readonly sha256: string;
}

/** Every comparable field, in report order. `observedAt` is excluded: it always differs. */
const FIELDS = [
  "requestedModel",
  "resolvedModel",
  "canonicalModel",
  "contextWindow",
  "maxOutputTokens",
  "serviceTier",
  "costBasis",
  "endpoint",
  "adapter",
  "adapterVersion",
  "harnessVersion",
] as const;

export type MetaField = (typeof FIELDS)[number];

export interface MetadataInput {
  readonly provider: string;
  readonly requestedModel: string;
  readonly response: ProviderResponse;
  readonly endpoint?: string;
  readonly adapterVersion?: string;
  readonly harnessVersion?: string;
  readonly tokenSource: TokenSource;
  readonly observedAt: string;
}

export function metadataOf(input: MetadataInput): ProviderMetadata {
  const r = input.response;
  const body = {
    requestedModel: metaValue(input.requestedModel),
    resolvedModel: metaValue(r.modelServed),
    canonicalModel: metaValue(r.canonicalModel),
    contextWindow: metaValue(r.contextWindow),
    maxOutputTokens: metaValue(r.maxOutputTokens),
    serviceTier: metaValue(r.serviceTier),
    costBasis: metaValue(r.costBasis),
    endpoint: input.endpoint === undefined ? metaUnknown() : metaValue(input.endpoint),
    adapter: metaValue(input.provider),
    adapterVersion:
      input.adapterVersion === undefined ? metaUnknown() : metaValue(input.adapterVersion),
    harnessVersion:
      input.harnessVersion === undefined ? metaUnknown() : metaValue(input.harnessVersion),
    tokenSource: input.tokenSource,
  };
  return {
    schemaVersion: 1,
    ...body,
    observedAt: input.observedAt,
    sha256: canonicalHash(body),
  };
}

/**
 * What kind of difference this is. Five values, and collapsing any two of them loses the point.
 *
 *   `changed`         both sides known, and they differ. The only one that is straightforwardly a fact.
 *   `appeared`        absent before, known now. The provider started disclosing something.
 *   `disappeared`     known before, absent now. The provider STOPPED disclosing something, which is
 *                     itself a change worth seeing and which a null-versus-null diff would hide.
 *   `both_absent`     neither side has it. NOT evidence of stability: this field established nothing.
 *   `indeterminate`   at least one side is `unknown`, so no comparison is possible at all. Reporting
 *                     this as "unchanged" is the specific lie this type exists to prevent.
 */
export type MetadataChangeKind =
  | "changed"
  | "appeared"
  | "disappeared"
  | "both_absent"
  | "indeterminate";

export interface MetadataChange {
  readonly field: MetaField | "tokenSource";
  readonly kind: MetadataChangeKind;
  readonly before: string;
  readonly after: string;
  /** One line a reader can act on, naming what the difference does and does not establish. */
  readonly note: string;
}

const classify = (a: MetaValue, b: MetaValue): MetadataChangeKind => {
  if (a.kind === "unknown" || b.kind === "unknown") return "indeterminate";
  if (a.kind === "not_exposed" && b.kind === "not_exposed") return "both_absent";
  if (a.kind === "not_exposed") return "appeared";
  if (b.kind === "not_exposed") return "disappeared";
  // Only reachable when the two values differ: `diffMetadata` skips confirmed matches before it
  // gets here, so there is no equal-value branch to write.
  return "changed";
};

const NOTES: Readonly<Record<MetadataChangeKind, string>> = {
  changed: "both sides reported this and they differ. A fact, with no p-value attached.",
  appeared:
    "the provider did not disclose this before and does now. Not a behaviour change by itself.",
  disappeared:
    "the provider disclosed this before and does not now. A null-versus-null diff would have called this unchanged.",
  both_absent:
    "neither run captured this, so it establishes nothing. This is not evidence that the field held still.",
  indeterminate:
    "at least one side is unknown, so no comparison is possible. This is not evidence that the field held still.",
};

/**
 * Compare two metadata records, reporting every field that is not a confirmed match.
 *
 * `both_absent` and `indeterminate` rows are RETURNED rather than filtered, because their whole
 * purpose is to be visible. A report that showed only `changed` rows would present a metadata
 * comparison in which the fields nobody could compare had quietly become fields that agreed.
 */
export function diffMetadata(
  before: ProviderMetadata,
  after: ProviderMetadata,
): readonly MetadataChange[] {
  const out: MetadataChange[] = [];
  for (const field of FIELDS) {
    const a = before[field];
    const b = after[field];
    if (a.kind === "value" && b.kind === "value" && a.value === b.value) continue;
    const kind = classify(a, b);
    out.push({ field, kind, before: renderMeta(a), after: renderMeta(b), note: NOTES[kind] });
  }
  if (before.tokenSource !== after.tokenSource) {
    out.push({
      field: "tokenSource",
      kind: "changed",
      before: before.tokenSource,
      after: after.tokenSource,
      note: "the token counts came from a different place. Cost and output-token comparisons across this boundary compare two different quantities.",
    });
  }
  return out;
}

/** Changes that are genuine differences rather than gaps in what was captured. */
export const substantive = (changes: readonly MetadataChange[]): readonly MetadataChange[] =>
  changes.filter((c) => c.kind === "changed" || c.kind === "appeared" || c.kind === "disappeared");

/** Fields nobody could compare. Reported so a reader knows the comparison was narrower than it looks. */
export const uncomparable = (changes: readonly MetadataChange[]): readonly MetadataChange[] =>
  changes.filter((c) => c.kind === "both_absent" || c.kind === "indeterminate");
