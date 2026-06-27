import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit/component tests live next to source under src/.
    // Playwright E2E specs in e2e/ are run separately via `pnpm test:e2e`.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
    environment: "node",
  },
});
