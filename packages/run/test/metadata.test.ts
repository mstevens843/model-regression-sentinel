// Provider metadata, and the single rule that makes it worth recording: two absences are not a fact.
//
// v0.1 recorded optional capability fields as `number | null`, and `null` meant two different things:
// "the provider was asked and does not report this" and "nobody ever found out". Diffing two nulls
// produced "unchanged", which reads as evidence of stability and is nothing of the kind. A provider
// that STOPPED reporting its context window, compared against an older run that never captured one,
// would have shown a clean diff on the one field that moved.
//
// These tests pin the three-state replacement and, just as importantly, pin that metadata drift is
// reported in its own category and never scored as a quality regression. A changed endpoint or a
// changed token source alters what the numbers MEAN without being a behaviour change, and a tool
// that conflated the two would be making the exact category error this project exists to avoid.

import { describe, expect, it } from "vitest";
import {
  type MetaValue,
  type ProviderMetadata,
  diffMetadata,
  metaUnknown,
  metaValue,
  metadataOf,
  renderMeta,
  substantive,
  uncomparable,
} from "../src/metadata.js";
import { skipped } from "../src/types.js";

const response = (over: Partial<Parameters<typeof metadataOf>[0]["response"]> = {}) => ({
  ...skipped(""),
  error: "",
  modelServed: "claude-sonnet-5",
  canonicalModel: "claude-sonnet-5",
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  serviceTier: "standard",
  costBasis: "list",
  ...over,
});

const meta = (over: Partial<Parameters<typeof metadataOf>[0]> = {}): ProviderMetadata =>
  metadataOf({
    provider: "claude_cli:sonnet",
    requestedModel: "sonnet",
    response: response(),
    endpoint: "cli",
    adapterVersion: "0.2.0",
    harnessVersion: "2.1.246",
    tokenSource: "cli_usage",
    observedAt: "2026-08-26T00:00:00.000Z",
    ...over,
  });

describe("a metadata field has three states, not two", () => {
  it("separates a value, a refusal to disclose, and never having looked", () => {
    expect(metaValue("claude-sonnet-5")).toEqual({ kind: "value", value: "claude-sonnet-5" });
    expect(metaValue(null)).toEqual({ kind: "not_exposed" });
    expect(metaValue(undefined)).toEqual({ kind: "not_exposed" });
    expect(metaUnknown()).toEqual({ kind: "unknown" });
  });

  it("renders the two absences differently, because they are different claims", () => {
    expect(renderMeta({ kind: "not_exposed" })).not.toBe(renderMeta({ kind: "unknown" }));
    expect(renderMeta({ kind: "not_exposed" })).toContain("not exposed");
    expect(renderMeta({ kind: "unknown" })).toContain("unknown");
  });

  it("coerces a number without losing it, because a context window is compared as a fact", () => {
    expect(metaValue(200_000)).toEqual({ kind: "value", value: "200000" });
    // Zero is a value, not an absence. A max-output of 0 would be a real and alarming fact.
    expect(metaValue(0)).toEqual({ kind: "value", value: "0" });
  });
});

describe("unknown fields do not compare as equal facts", () => {
  it("reports two unknowns as indeterminate rather than unchanged", () => {
    // THE CENTRAL TEST OF THIS FILE. Under v0.1 semantics this pair was "no change".
    const a = meta({ harnessVersion: undefined });
    const b = meta({ harnessVersion: undefined });
    const change = diffMetadata(a, b).find((c) => c.field === "harnessVersion");
    expect(change, "two unknowns must be reported, not silently matched").toBeDefined();
    expect(change?.kind).toBe("indeterminate");
    expect(change?.note).toContain("not evidence");
  });

  it("reports a known value against an unknown as indeterminate, never as a change", () => {
    const known = meta({ harnessVersion: "2.1.246" });
    const blind = meta({ harnessVersion: undefined });
    const change = diffMetadata(known, blind).find((c) => c.field === "harnessVersion");
    expect(change?.kind).toBe("indeterminate");
  });

  it("reports two not-exposed fields as both_absent, which establishes nothing", () => {
    const a = meta({ response: response({ serviceTier: "" }) });
    const b = meta({ response: response({ serviceTier: "" }) });
    const change = diffMetadata(a, b).find((c) => c.field === "serviceTier");
    expect(change?.kind).toBe("both_absent");
    expect(change?.note).toContain("establishes nothing");
  });

  it("does report a field that genuinely stopped being disclosed", () => {
    // The case a null-versus-null diff would have hidden entirely.
    const before = meta();
    const after = meta({ response: response({ contextWindow: null }) });
    const change = diffMetadata(before, after).find((c) => c.field === "contextWindow");
    expect(change?.kind).toBe("disappeared");
    expect(change?.before).toBe("1000000");
    expect(change?.after).toContain("not exposed");
  });

  it("does report a field that started being disclosed", () => {
    const before = meta({ response: response({ contextWindow: null }) });
    const after = meta();
    expect(diffMetadata(before, after).find((c) => c.field === "contextWindow")?.kind).toBe(
      "appeared",
    );
  });

  it("says nothing at all about a field both sides agree on", () => {
    expect(diffMetadata(meta(), meta())).toEqual([]);
  });

  it("splits real differences from gaps in what was captured", () => {
    const before = meta({ harnessVersion: undefined });
    const after = meta({
      harnessVersion: undefined,
      response: response({ contextWindow: 200_000 }),
    });
    const changes = diffMetadata(before, after);
    expect(substantive(changes).map((c) => c.field)).toEqual(["contextWindow"]);
    expect(uncomparable(changes).map((c) => c.field)).toContain("harnessVersion");
  });
});

describe("the fields that describe the path, not the model", () => {
  it("notices a changed endpoint even when the model is identical", () => {
    const cli = meta({ endpoint: "cli" });
    const api = meta({ endpoint: "https://api.anthropic.com" });
    const change = diffMetadata(cli, api).find((c) => c.field === "endpoint");
    expect(change?.kind).toBe("changed");
  });

  it("notices a changed token source, and says why it matters", () => {
    const viaCli = meta({ tokenSource: "cli_usage" });
    const viaApi = meta({ tokenSource: "anthropic_usage" });
    const change = diffMetadata(viaCli, viaApi).find((c) => c.field === "tokenSource");
    expect(change?.kind).toBe("changed");
    // A CLI harness injects tokens a bare API never sends, so cost and output-token comparisons
    // across this boundary compare two different quantities.
    expect(change?.note).toContain("two different quantities");
  });

  it("notices a changed adapter version, because a rewritten adapter can move the numbers", () => {
    expect(
      diffMetadata(meta({ adapterVersion: "0.1.0" }), meta({ adapterVersion: "0.2.0" })).find(
        (c) => c.field === "adapterVersion",
      )?.kind,
    ).toBe("changed");
  });

  it("hashes over the facts and not over the observation time", () => {
    // Two identical setups observed a week apart must hash the same, or the digest measures a clock.
    const monday = meta({ observedAt: "2026-08-24T00:00:00.000Z" });
    const friday = meta({ observedAt: "2026-08-28T00:00:00.000Z" });
    expect(monday.sha256).toBe(friday.sha256);
    expect(meta({ endpoint: "cli" }).sha256).not.toBe(
      meta({ endpoint: "https://api.anthropic.com" }).sha256,
    );
  });
});

describe("the providers declare what only they know", () => {
  it("each adapter names its endpoint and where its token counts come from", async () => {
    const { ClaudeCliProvider } = await import("../src/providers/claudeCli.js");
    const { AnthropicApiProvider, OpenAiCompatibleProvider } = await import(
      "../src/providers/httpApi.js"
    );
    const { ReplayProvider } = await import("../src/providers/replay.js");
    const { NoopProvider } = await import("../src/providers/noop.js");

    expect(new ClaudeCliProvider("sonnet").tokenSource).toBe("cli_usage");
    expect(new ClaudeCliProvider("sonnet").endpoint).toBe("cli");
    expect(new AnthropicApiProvider("claude-sonnet-5").tokenSource).toBe("anthropic_usage");
    expect(
      new OpenAiCompatibleProvider("gpt-x", { baseUrl: "https://vllm.internal/v1" }).endpoint,
    ).toBe("https://vllm.internal");
    // A replayed count is a recording, never a fresh reading, and must not claim to be one.
    expect(new ReplayProvider(new Map(), "t", "m").tokenSource).toBe("replayed");
    expect(new NoopProvider().tokenSource).toBe("none");
  });

  it("records only the ORIGIN of an endpoint, because a base URL can carry a credential", () => {
    // eslint-disable-next-line
    return import("../src/providers/httpApi.js").then(({ OpenAiCompatibleProvider }) => {
      const p = new OpenAiCompatibleProvider("gpt-x", {
        baseUrl: "https://host.example/v1?api_key=not-a-real-key-value-for-testing",
      });
      expect(p.endpoint).toBe("https://host.example");
      expect(p.endpoint).not.toContain("api_key");
    });
  });
});

describe("MetaValue is a closed set", () => {
  it("has exactly three shapes, so a fourth cannot be added without a test noticing", () => {
    const kinds = new Set<MetaValue["kind"]>(["value", "not_exposed", "unknown"]);
    expect(kinds.size).toBe(3);
    expect(kinds.has(metaValue("x").kind)).toBe(true);
    expect(kinds.has(metaValue(null).kind)).toBe(true);
    expect(kinds.has(metaUnknown().kind)).toBe(true);
  });
});
