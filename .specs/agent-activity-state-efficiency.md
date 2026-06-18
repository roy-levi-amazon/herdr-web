# Bridge-Owned Agent Activity Updates

## Summary

Make agent activity updates reach the browser quickly without rebuilding the full workspace
snapshot for every routine status change.

The bridge should own one shared Herdr subscription layer for agent activity and fan out compact
typed updates to connected browsers. Browser clients must not each create their own Herdr
agent-activity subscriptions. Full snapshots remain the source of truth for structural workspace
state and are used for initial load, structure changes, reconnects, and recovery.

## Problem

The current web client refreshes the full snapshot every 10 seconds and also refreshes it whenever
`/ws/events` or `/ws/ui-events` emits. A snapshot rebuild calls:

- `workspace.list`
- `tab.list`
- `pane.list`
- `pane.layout` once for each tab

That is acceptable for initial load and structural changes, but it is too expensive and too slow
for high-frequency user-visible activity like agent status, title, display agent, and custom status.
The result is that running agents can look stale until the next full refresh.

## Goals

- Deliver pane agent status/presentation changes to browsers with low latency.
- Avoid full snapshot rebuilds for routine agent activity changes.
- Keep one bridge-owned Herdr agent-activity watcher, shared across all web clients.
- Keep browser protocol end-state oriented and easy to recover from.
- Preserve full snapshots as the coherent structural state source.
- Keep implementation smaller than the previous full `/ws/state` stream design.

## Non-Goals

- No durable replay/cursor protocol. Herdr event streams are transient and bounded.
- No per-client Herdr subscriptions for agent activity. Existing per-client structural
  subscriptions stay in Phase 1.
- No browser-side reconstruction of structural state from Herdr structural events.
- No attempt to cache or patch terminal frame rendering.
- No broad compatibility layer for old and new state protocols.

## Herdr API Constraints

Herdr exposes:

- `events.subscribe` for structural events such as workspace/tab/pane lifecycle events.
- `events.subscribe` with `pane.agent_status_changed` subscriptions scoped to a specific pane ID.
- Current-state request/response methods such as `pane.list`, `workspace.list`, `tab.list`,
  `pane.get`, and `pane.layout`.

Important limitations:

- Herdr event subscriptions are transient. They are not durable cursors a browser can resume.
- Structural events can be partial relative to what the browser needs to render a coherent model.
- Agent-status subscriptions are per pane, so the bridge must refresh its subscribed pane set when
  panes are created, closed, or moved.
- There is no dedicated Herdr layout-changed event. Layout cache invalidation must be conservative.

## Proposed Architecture

### Shared Bridge Activity Watcher

The bridge maintains one background activity coordinator per bridge process.

The coordinator:

1. Builds or receives the current pane set from `pane.list`.
2. Opens an activity-only Herdr `events.subscribe` request containing one
   `pane.agent_status_changed` subscription per current pane.
3. Converts each Herdr subscription event into a compact bridge message.
4. Broadcasts that message over a bridge-local `tokio::sync::broadcast` channel.
5. Keeps a separate long-lived structural Herdr subscription that sends bridge-local rebuild
   signals after structural events.
6. Rebuilds the activity subscription from `pane.list` after those local structural signals.

The watcher is central. Browser count does not multiply Herdr agent-activity subscription count.
Existing `/ws/events` structural subscriptions stay per browser in Phase 1. The watcher also keeps
one bridge-owned structural subscription only so it can rebuild the pane activity subscription set.
The activity subscription must not include structural events; Herdr may replay retained structural
events to new subscriptions, and mixing them into the short-lived activity subscription can cause a
resubscribe loop. Collapsing structural subscriptions is future work.

### Browser Activity Stream

Add a browser WebSocket route:

- `GET /ws/activity`

Messages are typed JSON:

```json
{
  "type": "pane.agent_status_changed",
  "pane_id": "p1",
  "workspace_id": "w1",
  "agent_status": "working",
  "agent": "codex",
  "title": "Reviewing changes",
  "display_agent": "Codex",
  "custom_status": "running tests",
  "state_labels": { "working": "Running" }
}
```

Recovery control messages use the same stream:

```json
{
  "type": "resync_required",
  "reason": "activity receiver lagged"
}
```

The browser applies this message by patching the matching pane in its current snapshot. If the pane
is unknown, the browser requests a full snapshot refresh. The browser should not upsert unknown
panes from activity messages because unknown panes imply the structural snapshot is stale.

Bridge activity messages are full replacements for the pane's agent presentation fields. The bridge
must serialize nullable fields explicitly as JSON `null` when Herdr reports no current value:
`agent`, `title`, `display_agent`, and `custom_status`. The bridge must always serialize
`state_labels` as an object, using `{}` when empty. This avoids copying Herdr's raw
`skip_serializing_if` behavior into the browser protocol and lets the frontend clear stale values
with simple replacement semantics.

This replacement model is backed by the current Herdr daemon implementation, not just the
compatibility schema. In `/home/kevin/worktrees/herdr/src/app/api.rs`, emitted
`PaneAgentStatusChanged` events are built from the current `update.presentation` fields
(`title`, `display_agent`, `custom_status`, and `state_labels`) and current `agent_label`.
In `/home/kevin/worktrees/herdr/src/api/subscriptions.rs`, subscription polling either forwards
that event or falls back to `pane.get` and emits current `PaneInfo` fields from
`event_from_snapshot`. Therefore an absent optional field in a Herdr subscription event means the
current value is absent, not merely unchanged. If Herdr changes this contract in the future, the
bridge activity watcher must switch to merge-against-current-pane-state before broadcasting.

### Structural Changes

Structural events still cause full snapshot refreshes. They also trigger watcher resubscription.

Structural event sources include:

- workspace created/updated/renamed/closed/focused
- worktree created/opened/removed
- tab created/closed/focused/renamed
- pane created/closed/focused/moved/exited
- pane agent detected

The browser can keep using `/ws/events` to request a full snapshot refresh for these events. The
bridge's separate structural watcher also listens for structural events, coalesces/debounces bursts,
then tells the activity watcher to rebuild the subscribed pane ID set.

Resubscription is allowed to have a small gap while the watcher closes and reopens its Herdr
subscription with the new pane set. The structural event that caused the rebuild also causes
browsers to refresh the full snapshot, so any missed activity delta on an existing pane is recovered
from current state. The watcher should rebuild from `pane.list`, not from structural event payloads.

### Snapshot Coalescing

Add bridge-side snapshot coalescing before broader state-stream work:

- one rebuild lock prevents duplicate concurrent snapshot rebuilds
- a short-lived cached snapshot can be reused while no structural invalidation has occurred
- bridge-local selected pane is applied at response time, not baked permanently into cached state
- structural events and browser commands that mutate structure mark the cache dirty

This reduces duplicated full-state work while preserving `/api/snapshot` as the coherent fallback.

### Layout Efficiency

Layout collection should be improved separately from agent activity:

- collect per-tab layouts with bounded parallelism
- cache layouts only behind a conservative signature
- signature must include tab ID, workspace ID, focused tab state, focused pane ID, sorted pane IDs,
  and pane revisions
- invalidate layout cache on manual refresh, resync, structural events, and browser commands that
  can alter layout
- add a short TTL or equivalent backstop unless Herdr is verified to bump pane revisions for pure
  geometry changes from other clients

Do not use pane counts alone as a layout signature. Equal pane counts can still represent different
layout contents. Without a dedicated layout-changed event, the cache must accept either verified
revision semantics or bounded staleness through the TTL backstop.

## Frontend Behavior

The frontend keeps `Snapshot` as its primary view model.

On `/ws/activity` agent update:

1. If no snapshot exists, ignore the delta and allow normal snapshot loading.
2. If the pane exists, replace these pane fields from the bridge message:
   - `agent_status`
   - `agent`
   - `title`
   - `display_agent`
   - `custom_status`
   - `state_labels`
3. Recompute affected workspace/tab aggregate status from the patched pane set immediately.
4. If the pane is unknown, request a full snapshot refresh through the single-flight refresh path.

The client should keep the existing full snapshot refresh path for:

- initial load
- manual refresh
- connection/resume changes
- structural `/ws/events` messages
- unknown-pane activity deltas
- periodic safety refresh, at a lower frequency than today if activity stream is healthy

Full snapshot refreshes triggered by WebSockets must be single-flight per browser. If refreshes are
already in flight, later structural events, unknown-pane activity deltas, and resync requests should
set a pending-refresh flag instead of starting duplicate snapshot requests. When the in-flight
refresh completes, one pending refresh may run if needed.

## Failure Handling

- If the shared watcher fails to subscribe, it retries with exponential backoff.
- If the activity WebSocket disconnects, the browser reconnects with backoff.
- If the bridge detects that an activity WebSocket receiver lagged behind the local broadcast
  channel, it sends a typed `resync_required` control message and the browser requests a full
  snapshot refresh. The bridge should close the socket after sending that control message so
  reconnect starts from the current broadcast tail instead of replaying retained stale activity
  messages.
- If the watcher receives an event for a pane that is no longer present, the browser unknown-pane
  rule forces a full refresh and the watcher resubscription should converge after structural refresh.
- Full snapshot remains the correctness fallback.

## Implementation Plan

### Phase 1: Activity Deltas

- Add `activity_tx` to `BridgeState`.
- Add `/ws/activity`.
- Add a central bridge activity watcher.
- Keep structural resubscribe detection in a separate long-lived bridge-owned subscription; keep the
  pane activity subscription activity-only.
- Decode `SubscriptionEventEnvelope::PaneAgentStatusChanged`.
- Broadcast compact `ActivityMessage`.
- Patch frontend snapshots on activity messages.
- Send and handle `resync_required` control messages for broadcast lag.
- Recompute affected workspace/tab aggregate status after pane patches.
- Add a single-flight browser refresh path for WebSocket-triggered full snapshots, with stale-socket
  connection guards and follow-up refresh/discard behavior when an in-flight snapshot races with a
  newer activity patch.
- Keep existing `/ws/events` full-refresh behavior.

### Phase 2: Snapshot Coalescing

- Add dirty epoch and rebuild lock to bridge snapshot building.
- Reuse cached snapshots when no structural invalidation occurred.
- Invalidate cache after structural events and structure-mutating browser commands.
- Keep selected pane dynamic.

### Phase 3: Layout Work

- Parallelize per-tab `pane.layout` calls with bounded concurrency.
- Add conservative layout cache signature.
- Invalidate layout cache on structural/layout-affecting events and commands.

## Acceptance Criteria

- Agent status/custom status/title/display updates appear in the UI without waiting for the 10s
  snapshot poll.
- Multiple connected browsers do not multiply Herdr `pane.agent_status_changed` subscriptions.
- Unknown activity panes trigger a full snapshot refresh instead of being silently inserted.
- Structural events still refresh the full snapshot.
- If the activity watcher is down, the app still works through snapshots and `/ws/events`.
- Tests cover frontend activity patching, unknown-pane refresh behavior, bridge activity message
  decoding, and watcher subscription construction.
- Tests cover activity watcher resubscription triggers after structural events.
- Tests cover `resync_required` handling or socket-close recovery after broadcast lag.
- If snapshot coalescing is implemented, tests cover dirty-epoch invalidation, no duplicate
  concurrent rebuilds, and selected pane being applied dynamically at response time.
- If layout caching is implemented, tests cover signature invalidation and the TTL or verified
  revision backstop for pure geometry changes.
- No per-client `/ws/state` projection is introduced in this phase.

## Open Questions

- Should the periodic safety snapshot interval be reduced immediately, or only after activity
  updates have been validated on Android?
- For layout caching, can Herdr pane revisions be verified to change on pure geometry updates, or
  should the first implementation use a TTL backstop by default?

## Correspondence

### 2026-06-18T07:42:01.255Z - Reviewer: claude-default

Reviewed against the current bridge (`bridge/src/web_bridge.rs`), the herdr-compat
event schema (`vendor/herdr-compat/src/api/schema/events.rs`), and the frontend
(`web/src/App.tsx`, `web/src/types.ts`, `web/src/state.ts`).

Verified as correct:

- `Subscription::PaneAgentStatusChanged { pane_id, agent_status }` exists and is per-pane,
  and `PaneAgentStatusChangedEvent` carries exactly the fields the proposed `ActivityMessage`
  needs (`pane_id`, `workspace_id`, `agent_status`, `agent`, `custom_status`, `title`,
  `display_agent`, `state_labels`). The compact message shape is faithful to the source event.
- `EventsSubscribeParams.subscriptions` is a `Vec<Subscription>`, so one subscribe request with
  one `PaneAgentStatusChanged` per pane is supported.
- `PaneInfo.revision` exists in both bridge and frontend, so the layout signature can use it.
- `shared_selected_pane()` already applies selection at response time and prunes stale selections,
  so "selected pane stays dynamic, not baked into cache" is consistent with today's code.
- The watcher/broadcast model matches the existing `ui_event_tx` (`tokio::sync::broadcast`) pattern.

Findings the creator should address (details in structured output):

1. (high) Partial-field semantics: the event marks `agent`/`title`/`display_agent`/`custom_status`
   as `skip_serializing_if = Option::is_none` and `state_labels` skips when empty. The frontend
   step "replace only the changed pane fields" will erase persisted values if Herdr emits a
   status-only change without re-sending these. Define whether the event always carries full
   current values (replace) or may omit unchanged fields (merge), and implement accordingly.
2. (medium) Broadcast lag is detected bridge-side (`RecvError::Lagged`), not browser-side. The
   Failure Handling line "if broadcast receivers lag, the browser should request a full snapshot
   refresh" has no mechanism today — the existing handler just `continue`s on lag. This is the same
   gap as Open Question #2; it must be resolved (bridge emits a resync signal, or closes the socket)
   for the failure guarantee to hold.
3. (medium) Per-client structural subscriptions remain. `handle_events_socket` calls
   `open_event_subscription(api)` per `/ws/events` connection, and the watcher needs its own
   structural subscription too. This is in tension with Non-Goal "No per-client Herdr subscriptions."
   Clarify the scope: activity is shared; structural is per-client + 1 watcher.
4. (medium) Resubscription gap: changing the subscribed pane set means tearing down and reopening
   the activity subscribe; agent-status changes on unchanged panes during that window are dropped.
   The structural-event full refresh is the implicit safety net — state it explicitly and confirm
   pane-set changes always coincide with a structural event/refresh.
5. (medium) Unknown-pane refresh storm: each unknown-pane delta triggers a full snapshot refresh,
   and the current `refresh` path has no single-flight/debounce guard. Require coalesced/single-flight
   refresh to avoid storms when structure is briefly stale.
6. (medium) Layout cache staleness: with no Herdr layout-changed event, a geometry change from
   another client (divider drag) may not bump any pane revision, focus, or pane-id set, so the
   signature won't change. Verify revision-bump semantics for pure geometry changes, or add a TTL
   backstop. Currently only flagged as "conservative."
7. (medium) Aggregate roll-up: workspace/tab indicators come from `aggregateStatus(panes)`. Leaving
   recomputation as an open question conflicts with the acceptance criterion that status updates
   appear without the poll — roll-up chips would stay stale. Decide scope for Phase 1.
8. (low) Acceptance criteria omit Phase 2 (dirty-epoch/coalescing correctness, selected-pane stays
   dynamic) and Phase 3 (layout signature invalidation) tests, and watcher resubscription-on-
   structural-change. Add criteria.

### 2026-06-18T07:50:29.612Z - Reviewer: claude-default

Re-reviewed after the creator's revision. All eight prior findings are resolved:

1. (high, resolved) Nullable semantics now explicit: activity messages are full replacements;
   bridge serializes `agent`/`title`/`display_agent`/`custom_status` as JSON `null` when absent and
   `state_labels` as `{}` (lines 117-122). Frontend replacement semantics match (lines 180-186).
2. (medium, resolved) `resync_required` control message added on the activity stream with a
   bridge-side lag trigger (lines 104-111, 208-211).
3. (medium, resolved) No-per-client claim scoped to agent activity; per-client structural + one
   watcher-owned structural subscription documented as Phase 1, with collapsing deferred (lines
   39-40, 77-80).
4. (medium, resolved) Resubscribe gap stated explicitly with structural-refresh recovery and
   rebuild-from-`pane.list` (lines 140-143).
5. (medium, resolved) Single-flight WebSocket refresh with pending-refresh flag added (lines
   199-202, 188).
6. (medium, resolved) Layout TTL/verified-revision backstop added (lines 166-167, 170-171, 266-267).
7. (medium, resolved) Immediate aggregate workspace/tab recompute added (lines 187, 227).
8. (low, resolved) Acceptance criteria expanded for resubscription, resync, coalescing, and layout
   (lines 254-259).

One residual item (details in structured output):

1. (medium) The new "absent → null full replacement" model is correct only if the Herdr daemon
   emits the full current presentation state on every `pane.agent_status_changed` event. I checked
   `vendor/herdr-compat` schema and `tests.rs`: the fields decode as `Option` with `serde(default)`,
   and there is a subscribe-request fixture and an `events.wait` fixture, but no fixture of an actual
   event emission proving it carries full current values rather than only changed fields. If Herdr
   emits deltas, mapping absent→null will clear still-valid `title`/`agent`/`display_agent`/
   `custom_status` — reintroducing the original field-erasure bug. Recommend verifying the daemon's
   emit contract; if it is delta-based, the bridge should merge against last-known pane state instead
   of null-clearing. Otherwise the spec is ready to implement.

### 2026-06-18T07:52:50.211Z - Reviewer: claude-default

Re-reviewed after the creator added the source-backed emit-contract paragraph (lines 124-132).
Independently verified the cited Herdr daemon source and confirm the claim:

- `herdr/src/app/api.rs:441-453`: `PaneAgentStatusChanged` is emitted from `update.presentation.clone()`
  — `title`/`display_agent`/`custom_status`/`state_labels` come from the current presentation and
  `agent` from current `update.agent_label`. These are full current values, not changed-only deltas.
- `herdr/src/api/subscriptions.rs`: both delivery paths carry current values — the event-hub forward
  path (lines 337-391) passes the current event fields through, and the `pane.get` fallback
  (`event_from_snapshot`, lines 412-453) builds from current `PaneInfo` via
  `PanePresentationSnapshot::from`.
- `subscriptions.rs` test (lines 588-602) is decisive: a `custom_status` of `Some("short lived")`
  later emits an expiry event with `custom_status == None`. An absent optional therefore means the
  current value is absent/cleared, not unchanged — and the null-clearing replacement model is in fact
  required for custom-status TTL expiry to surface in the UI.

This resolves the last residual finding. The spec is correct against the current bridge, the
herdr-compat schema, and the Herdr daemon emit contract, and is ready to implement. The forward-compat
note (lines 130-132) to switch to merge-against-current-pane-state if Herdr's contract changes is an
appropriate guard. No further findings.
