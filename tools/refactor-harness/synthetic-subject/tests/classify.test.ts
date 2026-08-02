import { expect, test } from "vitest";

import { classify } from "../src/classify.js";

// Deliberately partial. `n === 0` and the "even" arm are never taken, and
// neverCalled/orphan/lint-issues are never imported at all -- so coverage
// must land strictly between 0% and 100%.
test("classify returns odd for a positive odd number", () => {
  expect(classify(3)).toBe("odd");
});

test("classify returns negative for a negative number", () => {
  expect(classify(-1)).toBe("negative");
});
