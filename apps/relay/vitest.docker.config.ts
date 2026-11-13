import { defineConfig } from "vitest/config";

// Docker / Compose entegrasyon testleri (Sprint 3 A2). Yalnızca CI'daki "Docker" işinde, önceden
// derlenmiş imajla ve SAKLAZ_DOCKER_TEST=1 iken çalışır. Testler sırayla ve tek süreçte koşar.
export default defineConfig({
  test: {
    include: ["test-docker/**/*.test.ts"],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
