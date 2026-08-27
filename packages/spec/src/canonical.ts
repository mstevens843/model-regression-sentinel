// Canonical JSON, and the content hash built on it.
//
// WHY THIS EXISTS AT ALL, given the sibling does not have it. `agent-context-containment` hashes
// RAW FILE BYTES, which is exactly right for a hand-authored corpus: `shasum -a 256 -c` works
// unmodified and the digest covers precisely what a reader would open. This project keeps that for
// the corpus, and cannot keep it for everything, because it also freezes GENERATED artifacts - a
// baseline snapshot is written by a program from an object, and `JSON.stringify` emits keys in
// insertion order. Rebuild the same logical snapshot with two fields swapped and the bytes change
// while nothing about the run did. A digest that moves when the content did not is worse than no
// digest, because the first false alarm teaches everyone to regenerate it.
//
// So there are two rules and they are applied to two different things:
//
//   hand-authored corpus files   hashed as RAW BYTES, so `shasum -c` interoperates
//   generated snapshots          written through `canonicalJson` and hashed from that string
//
// THE CANONICAL FORM: keys sorted ascending by code unit at every depth, two-space indent, one
// trailing newline. Sorted rather than insertion-ordered because insertion order is the property
// that varies. Indented rather than minified because these files get read by people during an
// incident, and a digest over a pretty form costs nothing.
//
// UNDEFINED AND NON-FINITE NUMBERS THROW rather than serializing to `null`. `JSON.stringify` drops
// an undefined property silently, which would let two logically different objects produce the same
// digest, and that is the one failure a content hash exists to prevent.

import { createHash } from "node:crypto";
import { type JsonValue, SentinelError } from "./types.js";

/**
 * Serialize to the canonical form: sorted keys at every depth, two-space indent, trailing newline.
 *
 * Throws `uncanonicalizable_value` on `undefined`, a function, a symbol, `NaN` or an infinity.
 */
export function canonicalJson(value: unknown): string {
  return `${render(value, "")}\n`;
}

/** The sha256 of the canonical form. For anything this project generates. */
export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** The sha256 of raw bytes. For anything a person authored and `shasum -c` will also check. */
export function bytesHash(bytes: Uint8Array | string): string {
  return createHash("sha256")
    .update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes))
    .digest("hex");
}

/**
 * Parse JSON without widening everything to `any`.
 *
 * Returns a Result rather than throwing because this reads foreign files - a corpus someone else
 * wrote, a snapshot from an older version - and a loader that throws on the first bad byte reports
 * one problem where there may be six.
 */
export function parseJson(text: string):
  | { readonly ok: true; readonly value: JsonValue }
  | {
      readonly ok: false;
      readonly error: string;
    } {
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

const INDENT = "  ";

function render(value: unknown, pad: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new SentinelError(
          "uncanonicalizable_value",
          `${String(value)} has no JSON representation, and serializing it as null would let two different objects hash the same`,
        );
      }
      // -0 and 0 are the same value for every purpose here; do not let them make two digests.
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "undefined":
    case "function":
    case "symbol":
      throw new SentinelError(
        "uncanonicalizable_value",
        `a ${typeof value} cannot be canonicalized; JSON.stringify would drop it silently and two different objects would hash the same`,
      );
    default:
      break;
  }

  // ONLY A PLAIN OBJECT OR AN ARRAY REACHES THE CODE BELOW, and this check is the whole reason to
  // write it out rather than let `Object.entries` handle whatever arrives.
  //
  // THE HOLE THIS CLOSES was the exact failure the module header argues against, in the module that
  // argues against it. `default: break` let every non-plain object fall through to `Object.entries`,
  // which returns [] for a Date, a Map, a Set, a RegExp and a class instance - so each rendered as
  // `{}`, and:
  //
  //     canonicalHash({ a: new Date(0) }) === canonicalHash({ a: new Date(999999) })   // true
  //
  // Two different objects hashing the same is the one thing this file exists to prevent. It threw
  // loudly on undefined, NaN, Infinity and -0 and then flattened everything else in silence.
  //
  // A REFUSAL, NOT A COERCION, and deliberately not `toJSON()`. Honouring `toJSON` would let a Date
  // serialize as an ISO string, which looks helpful and reopens the hole one level down: two
  // objects that differ only in something `toJSON` discards would hash the same again. A caller who
  // wants a Date in a digest has to say which representation of it they mean.
  // A null-prototype object is allowed: it is a plain data bag, `Object.entries` enumerates it
  // correctly, and it cannot collide with anything. Only prototypes that CARRY STATE `Object.entries`
  // cannot see are the hazard.
  const proto = Array.isArray(value) ? null : Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    const name = (value as object).constructor?.name ?? "value";
    throw new SentinelError(
      "uncanonicalizable_value",
      `a ${name} cannot be canonicalized: it is not a plain object, and Object.entries would render it as {} - so two different values would hash the same. Convert it to a plain JSON value first, choosing the representation you mean.`,
    );
  }

  const inner = pad + INDENT;

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => `${inner}${render(item, inner)}`);
    return `[\n${items.join(",\n")}\n${pad}]`;
  }

  // NOT filtered. `JSON.stringify` silently drops an undefined property, so {a:1} and
  // {a:1,b:undefined} produce the same string and could never be told apart by a digest. Dropping
  // it here would reintroduce exactly the hole this module exists to close, so an undefined value
  // reaches `render` and throws. The house convention already forbids assigning undefined: optional
  // fields are added by conditional spread and are simply absent, which serializes cleanly.
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  // Sorted by code unit, which is what `Array.prototype.sort` does by default on strings and what
  // any other language's sorted-key canonicalization will agree with for ASCII field names.
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const rendered = entries.map(([key, v]) => `${inner}${JSON.stringify(key)}: ${render(v, inner)}`);
  return `{\n${rendered.join(",\n")}\n${pad}}`;
}
