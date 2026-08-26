// Versioned, content-hashed prompt templates.
//
// WHY PINNING A PROMPT IS LOAD-BEARING HERE RATHER THAN TIDY. This project's entire claim is that
// behavior moved while the inputs did not. If the prompt is not pinned, an edit to it is
// INDISTINGUISHABLE FROM PROVIDER DRIFT: the numbers move, every byte the tool records looks the
// same, and the verdict is a false positive nobody can trace. Every recorded call therefore stores
// both the prompt id and its sha256, and a replayed baseline whose prompt hash no longer matches
// fails loudly instead of answering a different question with an old answer.
//
// The pattern is `toolcall-risk-classifier/src/toolcall_risk/bench/prompts.py`, including the
// observation that a registry with one entry proves nothing: a hash is only meaningful once there
// is something it could have been instead.
//
// THE SYSTEM PROMPT IS PART OF THE TEMPLATE, and it is short on purpose. A pilot on this machine
// measured an unstripped `claude` CLI call at 112,748 cache-creation tokens and $0.451, against
// 3,301 tokens and $0.0132 once the tool schemas were stripped and a minimal system prompt
// supplied. A canary set is paid for on every tick forever, so the difference between those two
// numbers is the difference between a watcher that runs and one that gets turned off.

import { bytesHash } from "./canonical.js";
import { type PromptId, promptId } from "./types.js";

export interface PromptVersion {
  readonly id: PromptId;
  readonly description: string;
  /** The system instructions, verbatim. This is what the hash covers. */
  readonly system: string;
  /** What a compliant answer looks like. Part of the version because graders are written to it. */
  readonly outputContract: string;
  /** Anything measured about how models actually behave under it. */
  readonly notes: string;
}

/** sha256 over the system instructions. Recorded on every call. */
export const promptHash = (p: PromptVersion): string => bytesHash(p.system);

const TERSE: PromptVersion = {
  id: promptId("terse-v1"),
  description:
    "Answer exactly as instructed, no preamble. For constrained categorical and numeric cases.",
  system:
    "You are a terse assistant answering questions about distributed systems and agent safety. " +
    "Answer exactly as the question instructs and add nothing else: no preamble, no explanation, " +
    "no restatement of the question.",
  outputContract: "Exactly the token the question asks for, and nothing else.",
  notes:
    "Measured on this machine, n=8 per case at default temperature: two constrained cases returned " +
    "8/8 byte-identical answers with no preamble. Compliance on constrained cases is high enough " +
    "that the graders can be exact-match rather than tolerant, and a shift away from that IS the " +
    "kind of drift this tool exists to see.",
};

const EXPLAIN: PromptVersion = {
  id: promptId("explain-v1"),
  description: "One-sentence free-form explanation. For the free_form archetype.",
  system:
    "You are a terse assistant answering questions about distributed systems and agent safety. " +
    "Answer in exactly one sentence.",
  outputContract: "One sentence of prose.",
  notes:
    "Measured on this machine, n=8: output tokens 61 to 94 (CV 18.5 percent) and latency 1780 to " +
    "8112 ms (CV 70.8 percent, one sample at 3.57x the median). Outputs clustered into about three " +
    "recurring lexical modes, with 3 of 8 sharing an identical 13-word prefix. This is the noisiest " +
    "archetype and the one that sets the floor on what a small sample can resolve.",
};

const DECIDE: PromptVersion = {
  id: promptId("decide-v1"),
  description: "Structured decision with a numeric confidence. For the structured_json archetype.",
  system:
    "You are a terse assistant answering questions about distributed systems and agent safety. " +
    "Return only the JSON object the schema describes. Do not wrap it in prose or a code fence.",
  outputContract:
    "A single JSON object matching the case schema, typically {decision, confidence, reason}.",
  notes:
    "Measured on this machine, n=3: the decision field was stable 3/3, confidence varied 0.80 / " +
    "0.85 / 0.90, output tokens ran 857 / 1062 / 1656 (CV about 32 percent) and latency 10.2 to " +
    "17.7 seconds. Reasoning tokens are included in the output count, which is why this archetype " +
    "is an order of magnitude noisier and slower than the constrained ones and why it lives in the " +
    "extended split rather than the canary.",
};

export const REGISTRY: ReadonlyMap<string, PromptVersion> = new Map(
  [TERSE, EXPLAIN, DECIDE].map((p) => [p.id as string, p]),
);

export const DEFAULT_PROMPT = TERSE;

export function getPrompt(id: PromptId | string): PromptVersion {
  const found = REGISTRY.get(String(id));
  if (found === undefined) {
    throw new Error(
      `unknown prompt id "${String(id)}"; known: ${[...REGISTRY.keys()].sort().join(", ")}`,
    );
  }
  return found;
}

export { TERSE, EXPLAIN, DECIDE };
