const FILTERED = "[FILTERED]";

export function filterParams(
  params: Record<string, unknown>,
  filterKeys: string[],
): Record<string, unknown> {
  const lowered = filterKeys.map((k) => k.toLowerCase());
  return walk(params, lowered);
}

function walk(
  value: Record<string, unknown>,
  loweredKeys: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (isSensitive(key, loweredKeys)) {
      out[key] = FILTERED;
    } else if (val && typeof val === "object" && !Array.isArray(val)) {
      out[key] = walk(val as Record<string, unknown>, loweredKeys);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function isSensitive(key: string, loweredKeys: string[]): boolean {
  const k = key.toLowerCase();
  return loweredKeys.some((needle) => k.includes(needle));
}
