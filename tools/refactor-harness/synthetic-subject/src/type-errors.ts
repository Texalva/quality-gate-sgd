/**
 * Deliberate type errors, at three distinct TS codes.
 *
 * These exist because the apollo-client golden baseline type-checks CLEAN:
 * `typescript.errors` is 0 and `issues.typescript` is empty. That means
 * parseTypescriptOutput() has never once been run against real tsc output,
 * and a refactor could break tsc error parsing outright while the golden
 * comparison still reported ACCEPTED.
 *
 * Nothing here violates a lint rule -- the lint findings live in
 * lint-issues.ts so the two dimensions stay independently countable.
 */

/** TS2322: Type 'number' is not assignable to type 'string'. */
export const wrongType: string = 42;

export function takesOne(x: number): number {
  return x;
}

/** TS2554: Expected 1 arguments, but got 2. */
export const wrongArity = takesOne(1, 2);

/** TS2339: Property 'b' does not exist on type '{ a: number; }'. */
export const missingProperty = { a: 1 }.b;
