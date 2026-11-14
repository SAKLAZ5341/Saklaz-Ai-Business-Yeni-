import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Etkileşimli komut satırı ve süreç giriş noktası: Windows CI'da paketlenmiş "selftest" ile,
      // servis akışı ise apps/relay/test/mvp-e2e.test.ts'de gerçek relay ile sınanır.
      exclude: ["src/app/cli.ts", "src/app/main.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
    },
  },
});
