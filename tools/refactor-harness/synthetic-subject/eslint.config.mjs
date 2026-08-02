import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

// Four rules, deliberately split across both severities. A subject whose
// findings are all one rule at one severity cannot distinguish a working lint
// adapter from one that drops warnings or collapses severity -- see
// GROUND-TRUTH.md.
export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      "no-console": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      eqeqeq: "error",
      "prefer-const": "error",
    },
  },
];
