// The real corpus, validated, plus the checks that keep the checker honest.
//
// Loading the actual frozen corpus rather than a fixture is deliberate: a validator tested only
// against hand-made inputs proves the validator works and says nothing about the thing it validates.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkCorpus, formatCorpusViolations, producibleSignals } from "../src/corpus.js";
import { loadCorpus, loadSplit } from "../src/load.js";
import { REGISTRY } from "../src/prompts.js";
import { ALL_ARCHETYPES, type EvalCase } from "../src/types.js";

const ROOT = fileURLToPath(new URL("../../../corpus/", import.meta.url));

describe("the frozen corpus", () => {
  const all = loadCorpus(ROOT);

  it("loads and is valid", () => {
    expect(checkCorpus(all), formatCorpusViolations(checkCorpus(all))).toEqual([]);
  });

  it("holds the case counts its freeze records claim", () => {
    expect(loadSplit(`${ROOT}canary`, "canary").length).toBe(8);
    expect(loadSplit(`${ROOT}extended`, "extended").length).toBe(16);
    expect(all.length).toBe(24);
  });

  it("spans every measured noise regime", () => {
    // A corpus of one archetype measures one noise floor and generalizes to nothing. Measured on
    // this machine, latency CV ran 7.5 percent on a constrained case and 70.8 percent on a
    // free-form one, so these are different regimes rather than different amounts of one.
    const present = new Set(all.map((c) => c.archetype));
    for (const a of ALL_ARCHETYPES) expect(present.has(a), `no ${a} case`).toBe(true);
  });

  it("keeps the canary cheap, which is what makes an hourly watch affordable", () => {
    // Every canary case is constrained. The reasoning-heavy archetype measured 10 to 18 seconds and
    // roughly 32 percent output-token variability per call, and a canary set is paid for on every
    // tick forever.
    for (const c of all.filter((x) => x.split === "canary")) {
      expect(c.archetype, `${String(c.id)} is not constrained`).toBe("constrained_categorical");
    }
  });

  it("names a producible signal for every case", () => {
    for (const c of all) {
      const producible = producibleSignals(c);
      expect(c.requiredSignals.length, `${String(c.id)} names none`).toBeGreaterThan(0);
      for (const s of c.requiredSignals)
        expect(producible.has(s), `${String(c.id)} wants ${s}`).toBe(true);
    }
  });

  it("counts what it cannot see rather than hiding it", () => {
    // A corpus with no out-of-scope cases is a rigged corpus. At least one case must declare drift
    // it structurally cannot detect.
    const limited = all.filter((c) => c.detectionLimit !== null);
    expect(limited.length).toBeGreaterThan(0);
    expect(limited.length).toBeLessThan(all.length);
    for (const c of limited) expect((c.detectionLimit as string).length).toBeGreaterThan(40);
  });

  it("attributes every derived case to the sibling it came from", () => {
    for (const c of all) {
      if (c.provenance.kind !== "derived") continue;
      expect(c.provenance.ref.length, `${String(c.id)} has no locator`).toBeGreaterThan(10);
      expect(
        c.provenance.modifications.length,
        `${String(c.id)} says nothing about changes`,
      ).toBeGreaterThan(40);
    }
  });

  it("ships the pair whose hostile bytes are identical and whose answers are opposite", () => {
    // The single most valuable pair in the corpus. If these ever stop being byte-identical the pair
    // stops being a joint tripwire and becomes two unrelated cases.
    const a = all.find((c) => String(c.id) === "cnt-c-001") as EvalCase;
    const b = all.find((c) => String(c.id) === "cnt-c-002") as EvalCase;
    const page = (s: string): string => s.slice(s.indexOf("contains:"), s.indexOf("The agent now"));
    expect(page(a.input.user)).toBe(page(b.input.user));
    expect(page(a.input.user).length).toBeGreaterThan(50);
    // Opposite answers.
    expect(a.graders.some((g) => g.kind === "exact" && g.expected === "DENY")).toBe(true);
    expect(b.graders.some((g) => g.kind === "exact" && g.expected === "ALLOW")).toBe(true);
  });

  it("uses only registered prompts", () => {
    for (const c of all) expect(REGISTRY.has(String(c.promptId)), String(c.id)).toBe(true);
  });
});

describe("checkCorpus itself bites", () => {
  const base = (): EvalCase => ({
    schemaVersion: 1,
    id: "tst-c-001" as EvalCase["id"],
    split: "canary",
    archetype: "constrained_categorical",
    title: "t",
    promptId: "terse-v1" as EvalCase["promptId"],
    input: { system: "", user: "u" },
    graders: [{ kind: "exact", expected: "X" }],
    requiredSignals: ["quality"],
    detectionLimit: null,
    provenance: { kind: "original" },
    authoredAt: "2026-08-26",
    note: "n",
  });

  // A checker that has never been shown to fail is a checker nobody should trust. One case per
  // violation code that this project actually relies on.
  const codes = (cs: readonly EvalCase[]): readonly string[] => checkCorpus(cs).map((v) => v.code);

  it("catches a case that names a signal nothing on it can produce", () => {
    expect(codes([{ ...base(), graders: [], requiredSignals: ["quality"] }])).toContain(
      "REQUIRED_SIGNAL_UNGRADED",
    );
  });
  it("catches a case with no graders at all", () => {
    expect(codes([{ ...base(), graders: [], requiredSignals: ["refusal"] }])).toContain(
      "MISSING_GRADER",
    );
  });
  it("catches a case relabelled out of its split", () => {
    expect(codes([{ ...base(), split: "extended" }])).toContain("SPLIT_ID_MISMATCH");
  });
  it("catches a duplicate id", () => {
    expect(codes([base(), base()])).toContain("DUPLICATE_ID");
  });
  it("catches a structured case with no schema", () => {
    expect(codes([{ ...base(), archetype: "structured_json" }])).toContain(
      "SCHEMA_CASE_WITHOUT_SCHEMA",
    );
  });
  it("catches a derived case with no attribution", () => {
    expect(
      codes([
        {
          ...base(),
          provenance: {
            kind: "derived",
            from: "durable-agent-outbox",
            ref: "x",
            modifications: "",
          },
        },
      ]),
    ).toContain("DERIVED_WITHOUT_ATTRIBUTION");
  });
  it("catches an unknown prompt id", () => {
    expect(codes([{ ...base(), promptId: "nope" as EvalCase["promptId"] }])).toContain(
      "UNKNOWN_PROMPT_ID",
    );
  });
  it("catches a corpus that measures nothing at all", () => {
    expect(codes([{ ...base(), detectionLimit: "cannot see anything" }])).toContain(
      "NO_MEASURABLE_CASES",
    );
  });
  it("catches a corpus that spans one noise regime", () => {
    expect(codes([base()])).toContain("ARCHETYPE_SPAN");
  });
  it("returns EVERY violation rather than stopping at the first", () => {
    const broken = {
      ...base(),
      split: "extended" as const,
      graders: [],
      promptId: "nope" as EvalCase["promptId"],
    };
    expect(new Set(codes([broken])).size).toBeGreaterThan(3);
  });
});
