import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Gerçek PostgreSQL kullanıldığı için testler sırayla çalışır.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { lines: 85, functions: 85, branches: 75, statements: 85 },
    },
  },
});
