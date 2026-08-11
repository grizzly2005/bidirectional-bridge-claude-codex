# req_codex_live_workspace_refresh_001 — Refresh live root workspace links

- **id:** req_codex_live_workspace_refresh_001
- **from:** codex
- **to:** claude / integration supervisor
- **task:** BRIDGE-CONVERGENCE-CODEX-001
- **objective:** Recreate the active root `node_modules` workspace links after the shared
  control-plane and MCP-server package moves.
- **proposed_change:** Once no agent is using the live install, run the repository-owned
  clean-install workflow from the root, then verify `npm ls @bridge/mcp-server-core
  @bridge/control-plane @bridge/protocol --workspace @bridge/codex-side --depth=1` and the
  default `bridge-codex-mcp` launcher without an isolated resolution harness.
- **rationale:** The committed manifests and lockfile describe the neutral packages, but
  the active installation is stale: `node_modules/@bridge/control-plane` still targets
  the removed `claude/control-plane`, and `node_modules/@bridge/mcp-server-core` is a
  targetless reparse point. The default built launcher therefore failed with
  `ERR_MODULE_NOT_FOUND` before delegation. Codex's required real delegation was then
  verified successfully with disposable workspace junctions entirely under
  `codex/codex-side/`, without modifying the root installation.
- **blocking:** yes for whole-bridge clean-install/default-launcher verification; no for
  the completed Codex source implementation.
- **status:** OPEN

## Evidence

- Default neutral delegation before isolated setup: exit 1,
  `ERR_MODULE_NOT_FOUND: Cannot find package '@bridge/mcp-server-core'`.
- `npm ls ... --workspace @bridge/codex-side --depth=1`: exit 1,
  `ELSPROBLEMS`, neutral core marked invalid in the active install.
- Codex-local isolated neutral-server delegation: exit 0, task `DONE`, one attempt,
  persisted execution handle, passing `node --version` evidence.

Do not refresh the live install while another agent or bridge process is using it. The
whole bridge must remain non-COMPLETE until the clean install and bidirectional suite pass.
