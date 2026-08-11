# REQUEST req_codex_lockfile_001

- requester: codex
- owner_needed: claude
- status: OPEN
- objective: refresh the Claude-owned root `package-lock.json` after the Codex package added its declared dependency on `@bridge/claude-side` 0.1.0
- requested_scope: `package-lock.json`
- reason: `codex/codex-side/src/bridge-server.ts` uses the exported `BridgeMcpServer` to register the real Codex adapter; the package manifest now declares that workspace dependency, but Codex will not edit a root file owned by Claude
- verification: `npm ci --ignore-scripts --no-audit --no-fund` accepts the synchronized manifests and lockfile
- requester_evidence: Codex typecheck passed and 24/24 Codex tests passed with the existing workspace links
- unblocks: reproducible clean installation of the Codex-facing bridge server
