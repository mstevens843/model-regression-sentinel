// A deliberately small JSON Schema checker.
//
// WHY NOT AJV. This package declares zero runtime dependencies, and that is a product claim rather
// than an accident: `spec` is imported by everything, including the watcher that runs on a schedule
// on somebody's build box. More to the point, a validator is part of the INSTRUMENT here. If the
// validator changes behavior between versions - and a full JSON Schema implementation has a great
// deal of behavior to change - then a shift in `schemaValid` is indistinguishable from provider
// drift, which is the exact confusion this whole project exists to prevent. A frozen instrument
// needs a frozen ruler.
//
// WHAT IS SUPPORTED, and the list is the honest limit rather than a roadmap: `type` (including a
// union of types), `properties`, `required`, `additionalProperties` as a boolean, `enum`, `items`,
// `minItems`, `maxItems`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`. Everything
// else is IGNORED, and `unsupportedKeywords` reports what was ignored so a case cannot quietly rely
// on a keyword this does not implement. A schema whose meaning depends on `$ref`, `allOf`, `oneOf`
// or `not` belongs in a case that says so, not in a validator pretending to understand it.

import type { JsonValue } from "./types.js";

export interface SchemaError {
  /** JSON-pointer-ish path to the offending value. `""` is the root. */
  readonly path: string;
  readonly message: string;
}

export interface SchemaResult {
  readonly valid: boolean;
  readonly errors: readonly SchemaError[];
  /** Keywords present in the schema that this checker does not implement. */
  readonly unsupportedKeywords: readonly string[];
}

const SUPPORTED: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "enum",
  "items",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "description",
  "title",
  "$schema",
]);

export function validateAgainstSchema(value: JsonValue, schema: JsonValue): SchemaResult {
  const errors: SchemaError[] = [];
  const unsupported = new Set<string>();
  walk(value, schema, "", errors, unsupported);
  return {
    valid: errors.length === 0,
    errors,
    unsupportedKeywords: [...unsupported].sort(),
  };
}

const typeOf = (v: JsonValue): string => {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "number") return Number.isInteger(v) ? "integer" : "number";
  return t;
};

const matchesType = (actual: string, want: string): boolean =>
  actual === want || (want === "number" && actual === "integer");

function walk(
  value: JsonValue,
  schema: JsonValue,
  path: string,
  errors: SchemaError[],
  unsupported: Set<string>,
): void {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return;
  const s = schema as Record<string, JsonValue>;

  for (const key of Object.keys(s)) if (!SUPPORTED.has(key)) unsupported.add(key);

  const actual = typeOf(value);

  const wanted = s.type;
  if (typeof wanted === "string") {
    if (!matchesType(actual, wanted)) {
      errors.push({ path, message: `expected type ${wanted}, saw ${actual}` });
      return;
    }
  } else if (Array.isArray(wanted)) {
    const names = wanted.filter((w): w is string => typeof w === "string");
    if (!names.some((w) => matchesType(actual, w))) {
      errors.push({ path, message: `expected one of ${names.join(", ")}, saw ${actual}` });
      return;
    }
  }

  const allowed = s.enum;
  if (Array.isArray(allowed)) {
    const hit = allowed.some((option) => JSON.stringify(option) === JSON.stringify(value));
    if (!hit) {
      errors.push({
        path,
        message: `${JSON.stringify(value)} is not one of ${allowed.map((o) => JSON.stringify(o)).join(", ")}`,
      });
    }
  }

  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) {
      errors.push({ path, message: `${value} is below the minimum ${s.minimum}` });
    }
    if (typeof s.maximum === "number" && value > s.maximum) {
      errors.push({ path, message: `${value} is above the maximum ${s.maximum}` });
    }
  }

  if (typeof value === "string") {
    if (typeof s.minLength === "number" && value.length < s.minLength) {
      errors.push({ path, message: `length ${value.length} is below minLength ${s.minLength}` });
    }
    if (typeof s.maxLength === "number" && value.length > s.maxLength) {
      errors.push({ path, message: `length ${value.length} is above maxLength ${s.maxLength}` });
    }
    if (typeof s.pattern === "string" && !new RegExp(s.pattern).test(value)) {
      errors.push({ path, message: `does not match /${s.pattern}/` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) {
      errors.push({ path, message: `${value.length} items is below minItems ${s.minItems}` });
    }
    if (typeof s.maxItems === "number" && value.length > s.maxItems) {
      errors.push({ path, message: `${value.length} items is above maxItems ${s.maxItems}` });
    }
    if (Array.isArray(s.items)) {
      // TUPLE `items`, which used to validate NOTHING. The array was passed to `walk` as if it were
      // a schema, and `walk` returns immediately on an array - so
      // `{type:"array",items:[{type:"number"},{type:"number"}]}` accepted `["wrong","types"]` with
      // `valid:true` and an EMPTY `unsupportedKeywords`. Silent, and silent in the channel built to
      // make under-validation loud.
      const tuple = s.items as readonly JsonValue[];
      value.forEach((item, i) => {
        const sub = tuple[i];
        if (sub !== undefined) walk(item, sub, `${path}[${i}]`, errors, unsupported);
      });
      if (s.additionalItems === false && value.length > tuple.length) {
        errors.push({
          path,
          message: `${value.length} items against a ${tuple.length}-item tuple, and additionalItems is false`,
        });
      }
    } else if (s.items !== undefined) {
      value.forEach((item, i) =>
        walk(item, s.items as JsonValue, `${path}[${i}]`, errors, unsupported),
      );
    }
    return;
  }

  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, JsonValue>;
    const props = (s.properties ?? null) as Record<string, JsonValue> | null;

    if (Array.isArray(s.required)) {
      for (const key of s.required) {
        if (typeof key === "string" && !(key in obj)) {
          errors.push({ path, message: `required property "${key}" is absent` });
        }
      }
    }
    if (props !== null && typeof props === "object") {
      for (const [key, sub] of Object.entries(props)) {
        if (key in obj) walk(obj[key] as JsonValue, sub, `${path}.${key}`, errors, unsupported);
      }
    }
    // THREE SILENT LOOSENINGS LIVED IN THIS BLOCK, all inside a keyword the module lists as
    // SUPPORTED - so none of them was reported in `unsupportedKeywords` either. `schemaValid` is a
    // GATING metric, so each one is a route to a false pass on a build gate.
    //
    //   1. `additionalProperties` as a SCHEMA OBJECT was ignored entirely: only `=== false` was
    //      handled, so `{properties:{a:{type:"number"}},additionalProperties:{type:"number"}}`
    //      accepted `{a:1, zzz:"anything"}`.
    //   2. `additionalProperties:false` with NO `properties` was skipped by the `props !== null`
    //      guard, so a schema that permits no properties at all accepted every object.
    //
    // Verified latent rather than live: all 12 schemas in the corpus today avoid these shapes.
    const extras = (): readonly string[] =>
      Object.keys(obj).filter((key) => props === null || !(key in props));

    if (s.additionalProperties === false) {
      for (const key of extras()) {
        errors.push({ path, message: `additional property "${key}" is not permitted` });
      }
    } else if (
      s.additionalProperties !== undefined &&
      s.additionalProperties !== true &&
      typeof s.additionalProperties === "object" &&
      s.additionalProperties !== null
    ) {
      for (const key of extras()) {
        walk(
          obj[key] as JsonValue,
          s.additionalProperties as JsonValue,
          `${path}.${key}`,
          errors,
          unsupported,
        );
      }
    }
  }
}
