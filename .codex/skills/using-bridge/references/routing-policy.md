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

### Cross-runtime review

For substantial implementation work, consider one bounded read-only review by the other
runtime.

For substantial security or architecture work, consider bounded implementation or
reproducibility verification by the other runtime.

## Delegation amount

For substantial work:

- prefer one useful bounded child when an independent verifiable subtask exists;
- allow a second child when it is genuinely independent or is a separate read-only review;
- do not exceed two children by default.

For trivial or tightly coupled work, keep the task local.

## Never route based on

- daily usage percentages
- remaining quota
- a goal of "using both models"
- automatic web searches for model rankings
- automatic benchmark execution

This is guidance, not proof of model superiority.
