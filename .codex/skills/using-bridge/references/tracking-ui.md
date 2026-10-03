# Opt-in delegation tracking

On “active le suivi de délégation”, “show delegation tracking”, or a comparable request:

1. Use the loaded `bridge_tracking_open` with a stable short `context_key` when multiple
   conversations share one server. Omit `run_id` to follow the latest and next root; supply
   an existing run only for an explicitly requested historical view.
2. Finish opening before calling `bridge_delegate`. The manager's root creation/binding and
   widget reader are separate from the long-running worker call. Reuse the existing root.
3. Prefer the inline MCP App on a compatible host. If the native host cannot render it,
   call open with `display: "browser"` for the authenticated loopback view. Never publish
   its fragment capability in the conversation, repository, an artifact or logs.
4. Let the widget read deterministically. Do not call telemetry tools or spawn another
   agent simply to animate the view. The graph represents lineage, not a progress estimate.

“Ferme le suivi” closes the current `view_id`. “Désactive le suivi” passes `disable: true`.
Workers continue. Do not turn either request into cancellation, recovery or process shutdown.
Closing a host panel stops its polling; an explicitly disabled preference remains disabled
until another explicit open. Views expire 24 hours after their last explicit opening;
an existing preference does not automatically open a window.

Read task result, runtime stop evidence and observation status separately. A delivered
business result can coexist with incomplete telemetry or quarantine. Unknown tokens and
durations remain unknown; legacy cumulative duration is not per-attempt runtime.

For ChatGPT connected through a private MCP tunnel, use the independent
`scripts/bridge-tracking-mcp.mjs` observer. It has five tracking tools and no task writer,
worker adapter or recovery operation. Connecting a viewer does not make it a manager.
Never tunnel the privileged native coordination server just to display tracking.

If tools or host rendering are unavailable, report the missing capability accurately.
Configuration, a local browser test and an offline DB query do not prove that the user's
ChatGPT account rendered the App. Do not alter credentials, client settings or automations
to bypass that boundary. Installation and host connection details are in
`docs/delegation-tracking.md` in the bridge repository.
