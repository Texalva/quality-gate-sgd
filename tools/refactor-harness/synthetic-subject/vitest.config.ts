import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      // istanbul rather than v8: the target stack keeps branch coverage, and
      // bun's own runner never emits BRDA records at all.
      provider: "istanbul",
      // `json` writes coverage-final.json, which the tool prefers for located
      // issues; `json-summary` writes the totals it falls back to. Emitting
      // both exercises the primary path rather than only the fallback.
      reporter: ["json", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts"],
      // Without this, files no test imported drop out of the denominator
      // entirely and the ratio silently flatters the subject.
      all: true,
    },
  },
});
