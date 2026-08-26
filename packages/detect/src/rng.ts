// A seeded generator, because an unreproducible statistic is a rumour.
//
// Every resample, permutation and simulation in this package draws from here and every one of them
// takes an explicit seed. `Math.random` is banned in this package and a test asserts it does not
// appear in the source, for two reasons that are not the same:
//
//   A bootstrap interval that moves between runs cannot sit in a report beside numbers that do not.
//   The sibling makes this point about its optional model judge and it applies with more force to a
//   confidence interval, which a reader will reasonably assume is a property of the data.
//
//   More importantly, THIS PACKAGE DECIDES WHETHER TO FAIL A BUILD. If a verdict at the boundary
//   flips between two runs on identical inputs, the tool is not measuring the provider, it is
//   measuring itself, and no amount of statistical machinery downstream can repair that.
//
// mulberry32: 32 bits of state, a well-known avalanche, and about ten lines. It is not
// cryptographic and does not need to be. It needs to be identical on every machine and every Node
// version, which a hand-written integer generator is and a platform PRNG is not.

/** A source of uniforms in [0, 1). Passed in everywhere; never constructed inside a statistic. */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An integer in [0, n). */
export const randomInt = (rng: Rng, n: number): number => Math.floor(rng() * n);

/**
 * A binomial draw, by summing Bernoullis.
 *
 * Naive on purpose. `n` here is a replicate count, which is single or low double digits, so the
 * inversion and rejection methods that pay off at large n would only add a source of numerical
 * disagreement between platforms for no measurable speed.
 */
export function binomial(rng: Rng, n: number, p: number): number {
  let k = 0;
  for (let i = 0; i < n; i += 1) if (rng() < p) k += 1;
  return k;
}

/** A Fisher-Yates shuffle in place, using the supplied generator. */
export function shuffle<T>(rng: Rng, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = randomInt(rng, i + 1);
    const a = items[i] as T;
    items[i] = items[j] as T;
    items[j] = a;
  }
  return items;
}
