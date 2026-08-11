#!/usr/bin/env node
/**
 * Repair the root `node_modules/@bridge/*` workspace links.
 *
 * Why this exists: npm creates workspace packages as symlinks/junctions into the repo. When
 * a package moves — as `@bridge/control-plane` did from `claude/` to `shared/` — a stale
 * install keeps pointing at the old path. On Windows and on network/FUSE mounts npm's own
 * cleanup can also fail partway, leaving zero-length reparse points that resolve to nothing
 * and that `rm -rf` refuses to delete. Compilation still succeeds (TypeScript resolves via
 * `paths` in `tsconfig.base.json`), so the breakage only appears at runtime as
 * `ERR_MODULE_NOT_FOUND` when a launcher starts.
 *
 * Reported by codex as `req_codex_live_workspace_refresh_001`.
 *
 * Usage:
 *   node scripts/repair-workspace-links.mjs          # report only
 *   node scripts/repair-workspace-links.mjs --fix    # recreate the links
 *
 * Do not run --fix while a bridge process is using the install.
 */

import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scope = join(repoRoot, "node_modules", "@bridge");
const fix = process.argv.includes("--fix");

/** Package name -> repo-relative directory. Keep in sync with the workspace globs. */
const PACKAGES = {
  protocol: "shared/protocol",
  "control-plane": "shared/control-plane",
  "mcp-server-core": "shared/mcp-server-core",
  "claude-side": "claude/claude-side",
  "codex-side": "codex/codex-side",
};

const log = (...a) => console.error(...a);
let problems = 0;
let repaired = 0;

mkdirSync(scope, { recursive: true });

for (const [name, target] of Object.entries(PACKAGES)) {
  const linkPath = join(scope, name);
  const targetAbs = join(repoRoot, target);

  if (!existsSync(targetAbs)) {
    log(`SKIP  @bridge/${name}: source directory ${target} does not exist`);
    continue;
  }

  let state = "missing";
  let current = null;
  try {
    const st = lstatSync(linkPath);
    if (st.isSymbolicLink()) {
      current = readlinkSync(linkPath);
      const resolved = resolve(dirname(linkPath), current);
      state = existsSync(join(resolved, "package.json")) ? "ok" : "broken";
      if (state === "ok" && resolve(resolved) !== resolve(targetAbs)) state = "stale";
    } else {
      state = st.isDirectory() ? "real-directory" : "unexpected";
    }
  } catch {
    state = "missing";
  }

  if (state === "ok") {
    log(`OK    @bridge/${name} -> ${current}`);
    continue;
  }

  problems++;
  log(`BAD   @bridge/${name}: ${state}${current ? ` (-> ${current})` : ""}; expected ${target}`);
  if (!fix) continue;

  try {
    rmSync(linkPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (err) {
    log(
      `      cannot remove existing entry: ${err.message}\n` +
        `      This filesystem refuses to unlink the corrupt entry. Delete the whole\n` +
        `      node_modules directory and run 'npm ci' from a normal local disk.`,
    );
    continue;
  }

  try {
    // "junction" is the only link type Windows creates without developer mode or elevation;
    // it is ignored on POSIX, where a normal directory symlink is used.
    symlinkSync(relative(dirname(linkPath), targetAbs), linkPath, "junction");
    log(`FIX   @bridge/${name} -> ${target}`);
    repaired++;
  } catch (err) {
    log(`      failed to create link: ${err.message}`);
  }
}

if (problems === 0) {
  log("\nAll @bridge workspace links resolve correctly.");
  process.exit(0);
}
if (!fix) {
  log(`\n${problems} problem(s). Re-run with --fix, or 'rm -rf node_modules && npm ci'.`);
  process.exit(1);
}
log(`\nRepaired ${repaired}/${problems}. Verify with: npm ls @bridge/mcp-server-core --depth=0`);
process.exit(repaired === problems ? 0 : 1);
