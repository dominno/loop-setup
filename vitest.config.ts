import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit/component tests live next to source under src/; the loop-setup kit (kit/) is plain
    // ESM and keeps its tests beside it; scripts/ holds the project's own script tests.
    // Playwright E2E specs in e2e/ are run separately via `pnpm test:e2e`.
    include: ["src/**/*.{test,spec}.{ts,tsx}", "kit/**/*.test.mjs", "scripts/**/*.test.mjs"],
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
    environment: "node",
    // The kit's tests read loop state through the layout resolver. They run against the frozen
    // legacy-v1 corpus, never a developer's live workspace, so they are deterministic everywhere
    // (CI has no workspace at all). Tests that need another workspace set their own.
    env: { LOOP_SETUP_WORKSPACE: resolve("kit/test/fixtures/legacy-v1") },
  },
});
