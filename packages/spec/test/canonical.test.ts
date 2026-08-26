// Canonical JSON, and the two failures it exists to prevent.
//
// The interesting assertions here are the ones about things `JSON.stringify` does QUIETLY: it drops
// an undefined property and serializes a NaN as null. Either would let two logically different
// objects produce the same digest, which is the one failure a content hash exists to prevent.

import { describe, expect, it } from "vitest";
import { bytesHash, canonicalHash, canonicalJson, parseJson } from "../src/canonical.js";
import { SentinelError } from "../src/types.js";

describe("canonicalJson", () => {
  it("sorts keys at every depth, so key order cannot churn a digest", () => {
    const a = { b: 1, a: { z: 1, y: 2 } };
    const b = { a: { y: 2, z: 1 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });

  it("ends with exactly one newline", () => {
    expect(canonicalJson({ a: 1 }).endsWith("}\n")).toBe(true);
    expect(canonicalJson({ a: 1 }).endsWith("}\n\n")).toBe(false);
  });

  it("indents with two spaces", () => {
    expect(canonicalJson({ a: { b: 1 } })).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n');
  });

  it("renders empty containers inline", () => {
    expect(canonicalJson({ a: [], b: {} })).toBe('{\n  "a": [],\n  "b": {}\n}\n');
  });

  it("preserves array order, because an array is data and not a set", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[\n  3,\n  1,\n  2\n]\n");
  });

  it("refuses undefined rather than dropping it silently", () => {
    // THE POINT. JSON.stringify({a: 1, b: undefined}) and JSON.stringify({a: 1}) are the same
    // string, so a digest over them could not tell the two apart.
    expect(JSON.stringify({ a: 1, b: undefined })).toBe(JSON.stringify({ a: 1 }));
    expect(() => canonicalJson({ a: 1, b: undefined })).toThrow(SentinelError);
  });

  it("refuses NaN and Infinity rather than writing them as null", () => {
    expect(JSON.stringify({ a: Number.NaN })).toBe('{"a":null}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(SentinelError);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(SentinelError);
  });

  it("treats negative zero as zero, so two equal values cannot make two digests", () => {
    expect(canonicalHash({ a: -0 })).toBe(canonicalHash({ a: 0 }));
  });

  it("hashes bytes and canonical form differently, which is the whole reason there are two", () => {
    const value = { b: 1, a: 2 };
    expect(canonicalHash(value)).not.toBe(bytesHash(JSON.stringify(value)));
  });

  it("returns a parse failure rather than throwing, because it reads foreign files", () => {
    const bad = parseJson("{not json");
    expect(bad.ok).toBe(false);
    const good = parseJson('{"a":1}');
    expect(good.ok).toBe(true);
  });
});
