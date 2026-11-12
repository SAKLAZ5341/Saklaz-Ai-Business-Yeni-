import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "json-summary"],
      // FAZ1-PLAN §10.1: crypto paketinde ≥ %95
      thresholds: { lines: 95, functions: 95, branches: 90, statements: 95 },
    },
  },
});
