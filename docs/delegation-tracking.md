# Delegation tracking V1

The tracking view is explicitly activated from a chat with “active le suivi de délégation”.
It displays a dotted master/child graph, an accessible list, attempt/resume details and a
paged run history. Closing the view never cancels a worker. All task, lease, execution and
recovery mutations stay in the existing coordination tools.

## Install and use

```sh
npm ci
npm run build
npm test
```

Reload the MCP connection in an already-running client after rebuilding. On a host that
supports MCP Apps, call `bridge_tracking_open` before starting the blocking delegation.
No root, runtime, agent, model call or recovery is needed to open tracking. The normal
manager creates its root as before; the view follows it and subsequent roots automatically.
An existing `run_id` pins a historical run; binding `null` restores automatic follow.

Hosts without MCP Apps can call `bridge_tracking_open` with `display: "browser"`. The
server opens a loopback browser view with a scoped temporary capability. Opening the HTML
without that capability is insufficient to read any data. If automatic browser opening
is unsupported, the independent reader below provides an explicit local URL.

```sh
node scripts/bridge-tracking-mcp.mjs --workspace /absolute/project --browser
```

That command prints a private capability URL to the interactive terminal's stderr.
Do not share or collect this URL. The browser removes its fragment immediately, keeps
the capability only in memory and sends it as an Authorization header. Reloading that
clean URL requires another explicit open. No capability enters a query string or cookie.

The fallback listener is bound to `127.0.0.1` on an ephemeral port. It rejects foreign
Host/Origin values, query credentials, arbitrary paths, unknown argument keys and all
nontracking operations. It has no CORS, persistent browser storage or mutable bridge API.
The HTML has a restrictive CSP and no external assets. Stop the standalone reader with
Ctrl+C; its shutdown closes readers/listeners and does not cancel any task.

## ChatGPT: an independent private observer

Run the following as the local command behind an authenticated, workspace-scoped private
MCP tunnel or an equivalent authenticated MCP host connection:

```sh
node /absolute/bridge/scripts/bridge-tracking-mcp.mjs --workspace /absolute/project
```

The default transport is MCP stdio. The tunnel terminates authentication and transports
only this observer's five tools and UI resource. This implementation does not create an
unauthenticated public endpoint or expose the privileged manager's native MCP server.
Use one configured workspace/DB per connector and restrict connector access to the user.
The widget cannot supply a path, workspace, caller identity or execution instruction.

ChatGPT requires a reachable authenticated connector; a local loopback URL cannot be
reached from its cloud service. Private tunnel/account setup is an external integration
step, not a hidden change to this repository. A viewer cannot delegate or recover because
those tools are absent from its server. The existing native manager retains its authority.
An independent reader also avoids a host that serializes a long `bridge_delegate` and
subsequent observation calls. Local fallback HTTP reads likewise remain independent.

## Wire and UI contracts

All five tools have actual MCP `outputSchema` and structured results. The open tool has
`_meta.ui.resourceUri`; its HTML resource uses `text/html;profile=mcp-app`, CSP metadata
and the official MCP Apps SDK. Open exports a compact structured summary for the model;
the initial full safe snapshot goes in UI-only `_meta.tracking_snapshot`. Subsequent reads
are widget calls, keeping graph polling outside model context. The app implements initialize, tool results, host theme,
tool calls, fullscreen request and teardown through that SDK. Legacy OpenAI template
metadata is supplied on open for compatible ChatGPT hosts. Ordinary bridge tools are
marked model-only in UI visibility metadata; this is a host hint, not remote authorization.
The independently exposed observer is the security boundary for a remote viewer.

| Tool | Input | Behavior |
| --- | --- | --- |
| `bridge_tracking_open` | optional run, context key, follow-current, inline/browser | opt in; deduplicate one live view per principal/context |
| `bridge_tracking_bind` | view, existing run or null | pin history or follow current/next root |
| `bridge_tracking_read` | view, optional signed after cursor | consistent safe full snapshot and bounded event catchup |
| `bridge_tracking_history` | view, signed page token, state/owner, limit <=50 | stable root history with keyset pagination |
| `bridge_tracking_close` | view, optional disable | close one view, or opt out all principal views |

Read/bind/history are widget-only visibility tools. Open/close can also be called by the
model in response to the user. Polling makes no model turn. `view_id` alone is not a remote
credential. The local browser capability is bound to the configured principal, workspace,
view and expiry; tokens/cursors are signed with a random key in a private sidecar.

Every snapshot includes schema version 1, workspace reference, view/run IDs, snapshot
event ID, observation time, stale-after duration, tasks, attempts, links, next cursor,
`has_more` and `truncated`. Exported names are neutral labels. Objectives, scopes, prompts,
transcripts, errors, handles, PIDs, generations, raw JSON and artifact content are never
part of the projection. Only known numeric token/duration measurements are exported.
An unknown measurement remains null. No progress percentage or estimated completion time
is inferred. Business status, execution phase/stop evidence and observation acceptance are
rendered separately. Resuming a child adds an attempt, not another graph node.

## Persistence and performance

The observer opens `bridge.db` with SQLite `readOnly: true`, `query_only=ON` and a 150 ms
busy timeout. It does not call ControlPlane.open, migrations, recovery or adapters.
Absent DB: a waiting view, without creating bridge.db. Schema other than exact v4:
safe refusal, without upgrading it. A read transaction covers event head and projection;
the next cursor advances only to the last consumed matching event on a truncated page.

UI preferences/views/key live in `<database filename>.tracking-ui.sqlite`, separately
from bridge.db. They are opened lazily on explicit tracking or an existing opt-in. Views
expire after 24 hours; maximum32 live contexts per configured principal. Closing
one view leaves other views and work running. Disabling closes all that principal's views.
No automatic activation or scheduled task is installed.

Read output is bounded to250 tasks,1000 attempts and250 events per catchup page. Larger
graphs explicitly show truncation. History pages contain20 roots by default, at most50.
New roots inserted during pagination do not shift older pages. The writable manager installs
lineage/history indexes after its existing migration; the observer never creates indexes.

Polling is2 seconds during activity and12–18 seconds while idle, zero while hidden or
offscreen. A widget has one timer and one in-flight read. Manual refresh respects the normal
30 reads/minute ceiling. Reconnect uses bounded jittered backoff; exceptional event catchup
uses at most five immediate pages before returning to normal cadence. A replaced DB or
changed run resets the signed cursor and resynchronizes. Stale/disconnected status stops
animations; reduced-motion preference and keyboard navigation are supported.

These are implementation bounds, not measured improvements to model speed or token cost.
Tracking does not change worker throughput. See the validation record for measured local
browser checks and the distinction from an actual ChatGPT account compatibility check.

## Validation and deferred scope

`npm test` includes privacy/authority, query-only state, schema refusal, cursor pagination,
history stability, preferences, closure, MCP registration, HTTP controls and UI polling/state.
`npm run test:tracking-ui` additionally exercises the built widget in a real browser.
See [the implementation record](DELEGATION_TRACKING_VALIDATION_2026-10-03.md).

Native floating Electron windows, task cancellation/resume buttons in the UI, multi-project
aggregation and advanced exports remain the PDF's deferred V2. They are deliberately not
part of the read-only V1. A real ChatGPT/native host must support MCP Apps and grant its
private connector; a browser harness cannot attest that account-specific integration.

Primary host references: [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview),
[ChatGPT UI](https://developers.openai.com/plugins/build/chatgpt-ui), and
[connector setup](https://developers.openai.com/plugins/deploy/connect-chatgpt).
