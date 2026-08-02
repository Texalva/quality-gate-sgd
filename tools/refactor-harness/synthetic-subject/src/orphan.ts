/**
 * Never imported by anything. With `all: true` it must still appear in the
 * coverage denominator at 0%; without that flag the file vanishes from the
 * report entirely and every ratio silently flatters the subject.
 *
 * This file is the negative control for the `all: true` setting itself.
 */
export function orphaned(flag: boolean): string {
  return flag ? "left" : "right";
}
