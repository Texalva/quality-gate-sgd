/**
 * Partially exercised by tests/classify.test.ts. The uncovered branches are
 * deliberate: a subject at 0% or 100% coverage cannot distinguish a working
 * coverage adapter from one that returns a constant.
 */
export function classify(n: number): string {
  if (n < 0) return "negative";
  if (n === 0) return "zero";
  return n % 2 === 0 ? "even" : "odd";
}

/** Exported but never called by any test -- must land at 0% function coverage. */
export function neverCalled(flag: boolean): string {
  return flag ? "yes" : "no";
}
