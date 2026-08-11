/**
 * Minimal JSON Schema validator (Draft-07 subset).
 *
 * Deliberately hand-rolled so `@bridge/protocol` stays dependency-free and can be
 * vendored into the Codex-side project without pulling a tree of packages. It
 * supports exactly the keywords used by the bridge schemas; anything else throws so
 * a schema author cannot silently rely on an unimplemented keyword.
 */

import { BridgeError, ErrorCode } from "./errors.js";

export type JsonSchema = {
  type?: JsonType | JsonType[];
  enum?: readonly unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  nullable?: boolean;
  anyOf?: readonly JsonSchema[];
  description?: string;
  title?: string;
  $id?: string;
};

type JsonType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

const SUPPORTED = new Set([
  "type", "enum", "const", "properties", "required", "additionalProperties", "items",
  "minItems", "maxItems", "minimum", "maximum", "minLength", "maxLength", "pattern",
  "nullable", "anyOf", "description", "title", "$id", "$schema",
]);

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

function typeOf(v: unknown): JsonType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  return "object";
}

function typeMatches(actual: JsonType, expected: JsonType): boolean {
  if (actual === expected) return true;
  // An integer is an acceptable number.
  return expected === "number" && actual === "integer";
}

function walk(value: unknown, schema: JsonSchema, path: string, issues: ValidationIssue[]): void {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) {
      throw new BridgeError(ErrorCode.INTERNAL, `Unsupported JSON Schema keyword: ${key}`, { path });
    }
  }

  if (schema.anyOf) {
    const branchIssues: ValidationIssue[][] = [];
    for (const sub of schema.anyOf) {
      const local: ValidationIssue[] = [];
      walk(value, sub, path, local);
      if (local.length === 0) return; // one branch matched
      branchIssues.push(local);
    }
    issues.push({
      path,
      message: `does not match any allowed variant (${branchIssues.length} tried)`,
    });
    return;
  }

  if (value === null && schema.nullable) return;

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!expected.some((e) => typeMatches(actual, e))) {
      issues.push({ path, message: `expected ${expected.join("|")}, got ${actual}` });
      return; // further checks would be noise
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    issues.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
  }

  if (schema.enum && !schema.enum.includes(value as never)) {
    issues.push({ path, message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}` });
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({ path, message: `shorter than minLength ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({ path, message: `longer than maxLength ${schema.maxLength}` });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      issues.push({ path, message: `does not match /${schema.pattern}/` });
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path, message: `below minimum ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path, message: `above maximum ${schema.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({ path, message: `needs at least ${schema.minItems} items` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({ path, message: `allows at most ${schema.maxItems} items` });
    }
    if (schema.items) {
      value.forEach((item, i) => walk(item, schema.items!, `${path}[${i}]`, issues));
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj) || obj[req] === undefined) {
        issues.push({ path: path ? `${path}.${req}` : req, message: "is required" });
      }
    }
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      const sub = props[k];
      const childPath = path ? `${path}.${k}` : k;
      if (sub) {
        walk(v, sub, childPath, issues);
      } else if (schema.additionalProperties === false) {
        issues.push({ path: childPath, message: "is not an allowed property" });
      } else if (typeof schema.additionalProperties === "object") {
        walk(v, schema.additionalProperties, childPath, issues);
      }
    }
  }
}

export function validate(value: unknown, schema: JsonSchema): ValidationResult {
  const issues: ValidationIssue[] = [];
  walk(value, schema, "", issues);
  return { valid: issues.length === 0, issues };
}

/** Validates or throws `INVALID_ARGUMENT` with every issue attached. */
export function assertValid<T>(value: unknown, schema: JsonSchema, label: string): T {
  const result = validate(value, schema);
  if (!result.valid) {
    throw new BridgeError(
      ErrorCode.INVALID_ARGUMENT,
      `${label} failed validation: ${result.issues.map((i) => `${i.path || "<root>"} ${i.message}`).join("; ")}`,
      { issues: result.issues as ValidationIssue[] },
    );
  }
  return value as T;
}
