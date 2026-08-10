import type { D1Result } from "@cloudflare/workers-types";

// `D1PreparedStatement.first()` already resolves to the first row directly (or
// null), so no unwrapping is needed here.
export function firstRow<T>(result: T | null): T | null {
  return result ?? null;
}

// `D1PreparedStatement.all()` resolves to a `D1Result` whose `results` array
// holds every row.
export function allRows<T>(result: D1Result): T[] {
  return (result.results ?? []) as T[];
}
