// `pnpm release` refuses, and says what would have to be true first.
//
// WHY A COMMAND THAT DOES NOTHING IS THE RIGHT THING TO SHIP HERE. The root manifest previously
// carried `"release": "changeset publish"`, the machine that built this repository has an
// authenticated `~/.npmrc`, and all seven package names are unclaimed on the registry. Those three
// facts together mean a single mistyped command would have published seven packages that:
//
//   have no README, so every npm page would be blank
//   would ship `workspace:` protocol ranges if packed with npm rather than pnpm
//   cannot be installed individually until the other six exist
//   carry a corpus freeze recorded as UNAVAILABLE, which a publish should disclose
//
// Publishing is irreversible in the way that matters: a version number cannot be reused, and an
// unpublish window is short and conspicuous. So the manifest no longer contains a command that
// could do it. `docs/PUBLISHING.md` carries the ordered gate, and cutting a release is a deliberate
// human act that starts by editing this file out of the way.
//
// This is not belt and braces. It is the same reasoning as `verify:freeze` exiting 1 by design:
// a repository should refuse to assert something it has not established, and "these packages are
// ready" is an assertion.

const BLOCKERS = [
  "no package carries a README, so all seven would publish as blank pages",
  "`npm publish` would ship `workspace:` ranges; the release builder packs with pnpm for this reason",
  "no single package installs on its own until the other six are published",
  "no changeset exists, so no version has been decided",
  "the corpus freeze is recorded UNAVAILABLE and a release should disclose that rather than omit it",
];

console.error("refusing to publish.");
console.error("");
console.error(
  "  This repository is pre-1.0, nothing here has ever been published, and the manifest",
);
console.error("  deliberately no longer contains a command that could publish it. Publishing is");
console.error("  irreversible in the way that matters: a version number cannot be reused.");
console.error("");
console.error("  Blockers, measured rather than remembered:");
for (const b of BLOCKERS) console.error(`    - ${b}`);
console.error("");
console.error(
  "  The ordered gate is in docs/PUBLISHING.md. Cutting a release is a deliberate human",
);
console.error(
  "  act that begins by editing scripts/refuse-publish.mjs out of the way, which is the",
);
console.error("  point: it cannot happen by autocomplete.");
console.error("");
console.error("  NO AGENT MAY PUBLISH THESE PACKAGES.");
process.exitCode = 2;
