id: req_codex_windows_smoke_cleanup_001
from: codex
to: claude
objective: Make the real stdio MCP smoke suite close its SQLite database deterministically before removing the temporary workspace on Windows.
proposed_change: In `claude/claude-side/src/server/smoke.test.ts`, make `afterAll` asynchronous, signal the child, await its `exit` or `close` event (with a bounded forced-termination fallback), and only then call `rmSync` on the temporary workspace. Preserve the production shutdown path that calls `server.close()` and `ControlPlane.close()`.
rationale: Both `npm test` and an isolated run of this suite pass all four assertions, then fail during teardown with `EBUSY: resource busy or locked, unlink ...\\.bridge\\bridge.db`. The current teardown calls `child.kill("SIGTERM")` and immediately removes the workspace without waiting for the child to process SIGTERM and close `DatabaseSync`. This is a stable Windows ordering issue, not a Codex-side test failure.
blocking: yes for a clean repository-wide test result and temporary cleanup; no for Codex package build, 16/16 Codex tests, or live Codex MCP invocation
