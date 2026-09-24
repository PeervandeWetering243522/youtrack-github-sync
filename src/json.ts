/**
 * The single entry point for untrusted JSON. Response bodies are read as text
 * and parsed here into a literal JSON type, so no `any`/`unknown` leaks into
 * the rest of the code. Modules narrow `JsonValue` with the guards below and
 * build their own typed objects from it.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = readonly JsonValue[];
// Index signature, not Record<>: a recursive alias cannot go through Record.
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

/** Parses JSON text. Throws SyntaxError on malformed input. */
export function parseJson(text: string): JsonValue {
  // JSON.parse is typed `any` in lib.es5; its output is JSON by definition.
  return JSON.parse(text) as JsonValue;
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonArray(value: JsonValue | undefined): value is JsonArray {
  return Array.isArray(value);
}

export function isString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

/** True for finite integers (JSON numbers can be fractional or huge). */
export function isInteger(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
