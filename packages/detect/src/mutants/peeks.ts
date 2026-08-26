// MUTANT. Models: a fixed-alpha test inside a cron job.
//
// THE MISTAKE THIS WHOLE PROJECT IS ORGANISED AROUND, on the continuous side, and the one that is
// hardest to see in review. There is nothing wrong with the test. A one-sided z-test on a
// proportion against a known null rate is correct, standard, and controls type-I error at 5 percent
// WHEN IT IS RUN ONCE. This mutant runs it again on every tick, against the accumulated data,
// forever.
//
// That is sampling to a foregone conclusion. The running proportion is a random walk around the
// null, and a walk that is checked against a fixed boundary at every step will eventually touch it
// with probability far above the nominal alpha, purely because it was checked so many times. Over
// the 900 observations scenario 05 supplies, a procedure advertised at 5 percent fires on a large
// fraction of pure-null watches.
//
// Nothing about the code looks wrong. The review that would catch it would have to be a conversation
// about optional stopping, which is why the fix has to be structural - an e-process whose guarantee
// holds at every stopping time - rather than a comment telling people to be careful.
//
// The injected change is the alarm rule. The wealth process is still computed and is still correct;
// it is simply not what decides.

import { type Detector, referenceDetector } from "../detector.js";
import { DEFAULT_ECONFIG } from "../eprocess.js";
import { normalCdf } from "../stats.js";

export const peeks: Detector = {
  name: "M5 peeks",
  compare: referenceDetector.compare,
  watchRound: (state, outcomes, config = DEFAULT_ECONFIG) => {
    const real = referenceDetector.watchRound(state, outcomes, config);
    const next = real.state;

    // THE BUG: a fresh one-sided test on the accumulated data, at every single look, with no
    // accounting for the fact that this is the four-hundredth look.
    const n = next.observations;
    const sd = Math.sqrt(n * next.p0 * (1 - next.p0));
    const z = sd === 0 ? 0 : (next.successes - n * next.p0 + 0.5) / sd;
    const p = normalCdf(z);
    const alarmed = state.alarmed || (n >= 30 && p <= config.alpha);

    return { state: { ...next, alarmed }, alarmed };
  },
};
