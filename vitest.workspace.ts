import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
      name: "simple-flame",
    },
  },
]);
