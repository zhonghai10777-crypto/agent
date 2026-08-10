/**
 * Shared plumbing for the inline pi extension tools (web access, document
 * reading, orchestration). Model-supplied arguments arrive untyped and models
 * routinely send numbers as strings, so parameter reading is defensive and
 * lives in one place rather than being re-derived per tool module.
 */

export function toolErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function stringParam(params: unknown, key: string): string | undefined {
  if (typeof params !== "object" || params === null) {
    return undefined;
  }
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function numberParam(params: unknown, key: string): number | undefined {
  if (typeof params !== "object" || params === null) {
    return undefined;
  }
  const value = (params as Record<string, unknown>)[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return undefined;
}
