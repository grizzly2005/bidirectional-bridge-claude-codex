# Routing policy

Status: provisional, manually maintained

## Purpose

Use this file as soft routing guidance.

Humans update this policy after reviewing occasional benchmark evidence. Managers must not
run comparative benchmarks or search for model rankings during ordinary user work.

Route according to task fit, not quota consumption.

## Current provisional preferences

### Prefer Codex for

- terminal-heavy implementation
- repeated build/test/fix loops
- repository-wide mechanical changes
- command-line debugging
- structured refactoring
- reproducible verification and automation
- implementation tasks with explicit acceptance tests

### Prefer Claude for

- security review and threat analysis
- adversarial review
- architecture and design critique
- specification/protocol review
- identifying hidden assumptions and edge cases
- reviewing unsupported or overstated claims
- independent review of substantial implementation work

### Prefer Gemini (Antigravity) for

- reading and summarizing very large code or documentation sets (1M-token context)
- a third, independent read-only review when Claude and Codex already disagree or share a blind spot
- fast iteration on settled changes, test writing and conversion scripts (Hydrogen)
- complex implementation or analysis when another subscription should absorb the work (Neon;
  Carbon for long-horizon verification on Ultra)

See [model-catalog.md](model-catalog.md) for model roles.

### Cross-runtime review

For substantial implementation work, consider one bounded read-only review by the other
runtime.

For substantial security or architecture work, consider bounded implementation or
reproducibility verification by another runtime.

## Delegation amount

For substantial work:

- prefer one useful bounded child when an independent verifiable subtask exists;
- allow a second child when it is genuinely independent or is a separate read-only review;
- do not exceed two children by default;
- an explicit user delegation share overrides this cap as described in the skill section
  "Honor an explicit delegation share".

For trivial or tightly coupled work, keep the task local.

## Never route based on (unless the user explicitly asks)

- daily usage percentages
- remaining quota
- a goal of "using both models"

An explicit user-requested delegation share ("délègue 50 %") is the user's own decision
about their subscriptions; follow it by moving real work, never by wasting tokens.
- automatic web searches for model rankings
- automatic benchmark execution

This is guidance, not proof of model superiority.
