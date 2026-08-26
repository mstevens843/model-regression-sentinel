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
