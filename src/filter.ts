const FILTERED = "[FILTERED]";
const TRUNCATED = "[TRUNCATED]";
const CIRCULAR = "[CIRCULAR]";
const MAX_STRING = 4096;
const MAX_ITEMS = 128;
const MAX_DEPTH = 8;

export type FilterKey = string | RegExp;

/**
 * Mask sensitive keys at any depth (inside arrays too) and make the value
 * safe to serialize: long strings and large or deeply nested collections are
 * cut, reference cycles are broken, and values JSON cannot carry (bigint,
 * functions, symbols) become strings.
 */
export function filterParams(
  params: Record<string, unknown>,
  filterKeys: FilterKey[],
): Record<string, unknown> {
  return sanitizeRecord(params, filterKeys);
}

/** Truncate and break cycles without masking anything. */
export function cleanRecord(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return sanitizeRecord(value ?? {}, null);
}

export function truncateString(value: string, limit = MAX_STRING): string {
  return value.length > limit ? `${value.slice(0, limit)}${TRUNCATED}` : value;
}

function sanitizeRecord(
  value: Record<string, unknown>,
  filterKeys: FilterKey[] | null,
): Record<string, unknown> {
  const keys = filterKeys
    ? filterKeys.map((key) => (typeof key === "string" ? key.toLowerCase() : key))
    : null;
  const result = walk(value, keys, 0, new Set());
  return result && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : {};
}

function walk(value: unknown, keys: FilterKey[] | null, depth: number, seen: Set<unknown>): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case "string":
      return truncateString(value);
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
    case "symbol":
      return String(value);
    case "function":
      return "[Function]";
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (value instanceof Error) return truncateString(`${value.name}: ${value.message}`);
  if (seen.has(value)) return CIRCULAR;
  if (depth >= MAX_DEPTH) return TRUNCATED;

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.slice(0, MAX_ITEMS).map((item) => walk(item, keys, depth + 1, seen));
    }
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (count++ >= MAX_ITEMS) break;
      out[key] = keys && isSensitive(key, keys) ? FILTERED : walk(item, keys, depth + 1, seen);
    }
    return out;
  } catch {
    return "[UNPRINTABLE]";
  } finally {
    seen.delete(value);
  }
}

function isSensitive(key: string, keys: FilterKey[]): boolean {
  const lowered = key.toLowerCase();
  return keys.some((needle) =>
    typeof needle === "string" ? lowered.includes(needle) : needle.test(key),
  );
}
