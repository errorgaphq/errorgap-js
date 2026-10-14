import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The fake ingestors in these tests count every request; the settings
    // poll is exercised on its own in hardening.test.ts.
    env: { ERRORGAP_REMOTE_SETTINGS: "false" },
    environment: "happy-dom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    globals: false,
  },
});
