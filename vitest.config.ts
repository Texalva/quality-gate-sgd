import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    exclude: ['**/node_modules/**', '**/dist/**', '**/tests/fixtures/**'],
    // v8 instrumentation costs ~3.8x wall-clock on this suite (40s -> 152s).
    // The tests/symbols/* files drive the TypeScript compiler API and average
    // ~4.1s each under coverage, which sits right on vitest's 5s default --
    // so whichever tests happened to lose the scheduling coin-flip failed,
    // and a different set failed on every run. These are not hangs.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      // NOTE: reportOnFailure is deliberately left at its default of false.
      // The gate has no test-pass/fail metric, so a failing suite only becomes
      // visible to it as a *missing* coverage floor. Emitting coverage anyway
      // would let a broken suite report healthy numbers and pass green.
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        // Interactive CLI files (require user input/terminal)
        'src/cli.ts',
        'src/init.ts',
        // MCP server files (require network/stdio transport)
        'src/mcp/**',
        // Pure type definitions (no runtime code)
        'src/types.ts',
        'src/**/types.ts',
        // Re-export index files
        'src/index.ts',
        'src/**/index.ts',
      ],
    },
  },
})
