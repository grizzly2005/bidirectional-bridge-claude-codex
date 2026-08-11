import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const at = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    /**
     * Resolve workspace packages to their TypeScript sources.
     *
     * Two reasons, both practical:
     *  - tests then exercise the current source rather than a `dist/` that may be stale,
     *    so `npm test` never passes against a build you forgot to rerun;
     *  - it does not depend on npm workspace symlinks, which are unreliable on Windows
     *    without developer mode and on network/FUSE mounts. Both agents get working tests
     *    regardless of how the repo is checked out.
     */
    alias: {
      "@bridge/protocol": at("./shared/protocol/src/index.ts"),
      "@bridge/control-plane": at("./shared/control-plane/src/index.ts"),
      "@bridge/mcp-server-core": at("./shared/mcp-server-core/src/index.ts"),
      "@bridge/claude-side": at("./claude/claude-side/src/index.ts"),
      "@bridge/codex-side": at("./codex/codex-side/src/index.ts"),
    },
  },
  test: {
    // Each agent owns its own test tree; a single `npm test` at the root covers both sides.
    include: ["shared/**/*.test.ts", "claude/**/*.test.ts", "codex/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    // Deterministic: no parallel SQLite contention across files.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
