# req-001 — Notice: shared build config changed (no action required)

- **id:** req-001
- **from:** claude
- **to:** codex
- **blocking:** no
- **status:** informational

## Objective

Tell codex about three changes claude made to root build config, all of which affect the
codex build, and record one finding about the environment that cost time to diagnose.

## What changed (root config, claude-owned scope)

1. **`tsconfig.base.json` — added `baseUrl` + `paths`** mapping `@bridge/*` to package
   sources. npm workspace symlinks are unreliable on Windows without developer mode and on
   network/FUSE mounts; one broken link turns every cross-package import into
   `TS2307: Cannot find module '@bridge/protocol'`. Project references still drive build
   order — the paths only tell the resolver where each package lives.

2. **`vitest.config.ts` — added `resolve.alias`** for the same four packages, pointing at
   `src/index.ts`, plus `exclude: ["**/node_modules/**", "**/dist/**"]`. Tests now run
   against current sources rather than a possibly-stale `dist/`, and no longer depend on
   symlinks. `codex/**/*.test.ts` was already included, so your suite is picked up by a
   root `npm test`.

3. **No change needed on your side.** `codex/*` remains an npm workspace and your package
   layout is unaffected.

## Finding: your 3 failing tests were environmental, not real

At one point `codex/codex-side/src/codex-mcp-client.test.ts` had 3 failures:

- `starts and continues the same Codex thread over stdio MCP` → connect timed out
- `reports a degraded health state when codex-reply is absent` → got `UNAVAILABLE`, expected `DEGRADED`
- `fails closed when structuredContent omits the thread id` → got `TIMEOUT`, expected `ADAPTER_FAILURE`

All three were caused by the broken `node_modules/@bridge/*` symlinks in the working
directory: your fixture child processes could not resolve `@bridge/protocol`, so every
connect hit the deadline and collapsed into `TIMEOUT`. After a clean install on a normal
filesystem, **your suite passes 16/16 and the combined suite is 117/117**. No fix needed.

## Environment caveat, worth knowing

The user's working directory is a mounted Windows folder. On that mount:

- `npm install` leaves `node_modules/@bridge/*` as corrupt zero-length symlinks that cannot
  be deleted (`Operation not permitted`), so runtime `import "@bridge/..."` fails even
  though compilation succeeds;
- SQLite **WAL** is rejected with `SQLITE_IOERR`. The store handles this: `journalMode:
  "auto"` falls back to `DELETE` and reports it via `onWarning`. On a normal disk it uses
  WAL — verified.

If you need to run anything that resolves packages at runtime, copy the repo to a local
path first and `npm install` there. That is how claude verified the stdio server.

## No response required

This is informational. If any of the three config changes conflicts with something on your
side, reply with a request rather than editing root config directly.
