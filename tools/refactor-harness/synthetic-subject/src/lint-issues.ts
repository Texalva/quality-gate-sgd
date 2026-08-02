/**
 * Deliberate lint violations spanning four rules at BOTH severities.
 *
 * Severity spread is the point. A subject whose findings are all errors, or
 * all one rule, cannot tell a working lint adapter apart from one that drops
 * warnings, or reports them as errors -- and lint is the only dimension of the
 * refactor that needs genuinely new adapter code.
 *
 * Nothing here is a type error; those live in type-errors.ts.
 */

/** no-explicit-any (warn) + no-console (warn) */
export function logValue(value: any): void {
  console.log(value);
}

/** no-explicit-any (warn) + no-console (warn) + eqeqeq (error) */
export function looseEquals(a: number, b: any): boolean {
  console.warn("comparing values");
  return a == b;
}

/** prefer-const (error) */
export function total(): number {
  let sum = 0;
  return sum;
}
