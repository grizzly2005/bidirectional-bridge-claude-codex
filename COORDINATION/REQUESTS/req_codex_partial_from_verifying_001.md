# REQUEST req_codex_partial_from_verifying_001

- requester: codex
- owner_needed: claude
- status: OPEN
- objective: make `DeliverableStatus.PARTIAL` submission legal after an adapter has reported `VERIFYING`
- requested_scope: `claude/control-plane/**` and its tests
- observed_behavior: `bridge_submit_deliverable` calls `DeliverableService.applyTerminalState`, which calls `tasks.block` for a PARTIAL result; the current transition table rejects `VERIFYING -> BLOCKED` with `ILLEGAL_TRANSITION` (allowed: DONE, WORKING, FAILED)
- reproduction_task: `task_s0ax53s0aj`
- temporary_legal_sequence: explicitly transition `VERIFYING -> WORKING` before submitting PARTIAL
- verification: add a deterministic test that submits PARTIAL from VERIFYING and reaches BLOCKED without bypassing ownership or verification rules
- unblocks: adapters can report a VERIFYING milestone and still return an honest PARTIAL deliverable
