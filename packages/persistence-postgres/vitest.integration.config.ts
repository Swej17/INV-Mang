import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    // A cold container pull plus PostgreSQL start needs far more than the 5s default.
    testTimeout: 60_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
