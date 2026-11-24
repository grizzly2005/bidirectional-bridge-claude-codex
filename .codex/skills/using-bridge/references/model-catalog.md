# Runtimes, models and roles

Status: dated hints (checked 2026-11-24), not authority. The signed-in runtime decides which
slugs exist: `claude --help` / `/model`, Codex `/model`, `agy models`. Plans change access.
Without an explicit choice every worker runs its **runtime default**; change it only on the
user's request with `bridge_set_model_preference` (workspace-wide) or `spec.model` (one task).

## Claude Code (`runtime: "claude"`)

| Slug | Role |
|---|---|
| `opus` / `claude-opus-5-5` | Deepest Claude model: security and architecture review, adversarial review, hard diagnosis. |
| `sonnet` / `claude-sonnet-5-5` | Balanced implementation and review. |
| `haiku` / `claude-haiku-5-5` | Fast, inexpensive mechanical work. |

Effort: `low`, `medium`, `high`, `max` (check `claude --help` for the installed version).

## Codex (`runtime: "codex"`)

| Slug | Role |
|---|---|
| `gpt-5.6-sol` | Detail and polish; the recommended default for ChatGPT sign-in. |
| `gpt-5.6-terra` | Everyday workhorse for implementation and build/test/fix loops. |
| `gpt-5.6-luna` | Clear, repeatable, mechanical work. |

Effort maps to `model_reasoning_effort`: `minimal`, `low`, `medium`, `high`, `xhigh`.
GPT-5.5 and GPT-5.4 left Codex for ChatGPT sign-in in 2026; do not select them there.

## Gemini via Google Antigravity (`runtime: "gemini"`)

The worker is the Antigravity CLI `agy` (Gemini CLI stopped serving Google AI Pro/Ultra on
2026-06-18; the legacy `gemini` binary remains selectable with `--gemini-dialect gemini-cli`).
It is enabled only with `--gemini-auth api-key` or `enterprise`: Google's Antigravity FAQ does
not support third-party agents driving a consumer login. With an API key, model access and
prices follow the Gemini API, not the Antigravity picker below. To spend a Google AI Pro/Ultra
plan, use Antigravity as the manager.

| Model (`agy models` slug may add an effort suffix) | Role | Access |
|---|---|---|
| `gemini-4-neon` | Complex software and analysis work where speed matters; close to Carbon on coding, faster and cheaper per task. Default thinking high. | Pro, Ultra |
| `gemini-4-carbon` | Deepest Gemini 4: long-horizon work and deep verification. Default thinking medium. | Ultra |
| `gemini-4-hydrogen` | Fast everyday model: tests, conversion scripts, settled changes, quick iterations. Default thinking high. | All paid plans |
| `gemini-4-argon` | Efficient reasoning model; marked "Leaving soon" in Antigravity — avoid for new work. | Pro, Ultra |
| `gemini-3.8-flash` | Previous fast model; "Leaving soon". | — |
| Orchestrator (e.g. `gemini-pro-orchestrator`) | Antigravity preset: Neon/Carbon plans and reviews, Hydrogen implements, in one session. | Pro/Ultra |

Antigravity also offers Claude Opus/Sonnet 5.5 and GPT-OSS 120B inside the Google
subscription. Selecting them for the `gemini` runtime spends Google credits, not the Claude
subscription — useful only when that is what the user wants.

Effort (`--effort`): `low`, `medium`, `high`, `xhigh`, `max` depending on the model; Neon and
Hydrogen accept up to `xhigh`, Carbon and Argon up to `high`.

## Choosing under an explicit delegation share

To use a different subscription limit, delegate to a runtime other than the manager's.
Prefer the model whose role fits the chunk; a cheaper model (Hydrogen, Terra/Luna, Sonnet)
for long mechanical chunks lets the same limit absorb more delegated work.
