import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Deterministic dates and Intl output in every test worker (workers inherit this process's environment)
process.env.TZ = "UTC";
process.env.LANG = "en_US.UTF-8";

export default defineConfig({
  resolve: {
    // Mirrors the "@/*" path in tsconfig.json, which stays the single source of truth for type checking
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
    // Undo vi.spyOn / vi.stubGlobal / vi.stubEnv after every test so no test leaks state into the next
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
  },
});
