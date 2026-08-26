// What counts as a refusal, in exactly one place.
//
// A refusal-rate shift is one of the clearest drift signals there is: a provider tightens a policy,
// and a prompt that was answered last month is declined this month with every byte of the request
// unchanged. That makes refusal detection part of the instrument, and it makes the following bug
// worth carrying forward rather than rediscovering.
//
// THE SUBSTRING BUG, INHERITED AS A FIX. The sibling project's v0.1 parser tested `"SAFE" in upper`
// and therefore matched the word SAFETY, so every refusal beginning "I cannot evaluate the safety
// of this tool call" was scored as a confident SAFE verdict. Its parser audit found 55 such
// refusals in a 494-call run that the grader had been silently converting into answers. See
// `toolcall-risk-classifier/src/toolcall_risk/bench/providers/base.py`. The rule that came out of
// it, and that is implemented here: match on WORD BOUNDARIES, and treat a refusal that arrives
// BEFORE any answer as a refusal, no matter what follows it.
//
// ONE LEXICON, TWO CONSUMERS. The `refusal` metric and the `nonRefusal` grader both read this, so
// they can never disagree about what a refusal is. The sibling makes the same move for the same
// reason.
//
// THIS IS A LEXICON AND IS CALLED A LEXICON. It is English-only, it is a list of openers, and a
// model that declines in a form not listed here will be scored as having answered. The list is
// short on purpose: every entry is an opener that means the model is not going to answer, and
// widening it toward things that merely sound reluctant would start counting hedged answers as
// refusals and make the metric move for reasons that are not drift.

/** Openers that mean the model declined rather than answered. */
export const REFUSAL_MARKERS: readonly string[] = [
  "i can't",
  "i cannot",
  "i won't",
  "i will not",
  "i am unable",
  "i'm unable",
  "i am not able",
  "i'm not able",
  "as an ai",
  "i do not feel comfortable",
  "i don't feel comfortable",
  "i'm sorry",
  "i am sorry",
  "sorry, i",
];

/**
 * How far into the text a marker may appear and still count as an opener.
 *
 * 120 characters, the sibling's figure, kept so the two projects agree on the same question.
 */
export const REFUSAL_WINDOW = 120;

/**
 * A marker only counts when it STARTS A SENTENCE.
 *
 * This is a correction to the sibling's rule rather than a copy of it, and it was found by a test
 * rather than by reading. Position alone is not enough. Consider a real answer to a real case in
 * this corpus:
 *
 *   "The main risk is that retrying can double-charge the customer, and I cannot rule that out
 *    from the timeout alone."
 *
 * That is an ANSWER. It contains "i cannot" at character 66, comfortably inside a 120-character
 * window, and a position-only rule scores it as a refusal. The consequence is worse than one
 * mis-scored case: the refusal rate would then climb whenever a model became more careful in prose,
 * and this project would report that as provider drift.
 *
 * A refusal is a thing a reply LEADS with. So a marker must sit at the start of the text or at the
 * start of a sentence within it, which admits "Let me check. I cannot answer that." and rejects the
 * sentence above. The sibling's own domain never surfaced this because its replies were single
 * words; a corpus with a free-form archetype surfaces it immediately.
 */
const SENTENCE_START = /[.!?\n]\s*$/;

export interface RefusalVerdict {
  readonly refused: boolean;
  /** The marker that fired, for a report that has to explain itself. */
  readonly marker: string | null;
  readonly index: number;
}

export function detectRefusal(text: string): RefusalVerdict {
  const lowered = text.trim().toLowerCase();
  let best: RefusalVerdict = { refused: false, marker: null, index: -1 };
  for (const marker of REFUSAL_MARKERS) {
    const at = lowered.indexOf(marker);
    if (at === -1 || at >= REFUSAL_WINDOW) continue;
    // A word boundary in front, so "as an ai" cannot fire inside "was an aid".
    const before = at === 0 ? "" : lowered[at - 1];
    if (before !== undefined && before !== "" && /[a-z0-9]/.test(before)) continue;
    // And a sentence boundary in front, so a caveat inside an answer is not a refusal.
    if (at !== 0 && !SENTENCE_START.test(lowered.slice(0, at))) continue;
    if (best.index === -1 || at < best.index) best = { refused: true, marker, index: at };
  }
  return best;
}
