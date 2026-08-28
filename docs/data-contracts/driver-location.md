# Driver Location and Find My Bus Contract

Date: 28 August 2026

The passenger-compatible projection remains:

```text
tours/{tourId}/driverLocation
```

It is server-owned. Mobile and web clients cannot publish or remove it directly.

## Source records

Automatic live sharing is isolated by app session and sharing lifecycle:

```text
driver_location_sessions/{appSessionId}|{liveSharingSessionId}
```

The canonical fixed pickup source is separate:

```text
driver_location_pickups/{tourId}
```

Both use schema version 2 and carry exact `authUid`, `appSessionId`, `driverId`, and
`tourId` ownership. A live source additionally carries `liveSharingSessionId` and
`cleanupAtMs`. Coordinates, server-resolved timestamps, and accuracy from 0 to
10,000 metres are mandatory and bounded for live sources. Rules require the path
key to match both lifecycle IDs and bind every write or exact-leaf delete to the
current active driver session, current policy generation, user mapping, and exact
manifest assignment.

Only a live leaf arms `onDisconnect`, and only for its own composite key. A fixed
pickup is never embedded as a live fallback and cannot be touched by a stale
handset's disconnect handler.

## Versioned record

The server projects the selected source to schema version 1:

```ts
{
  schemaVersion: 1,
  isSharing: true,
  mode: 'pickup' | 'live',
  source: 'manual' | 'auto',
  latitude: number,
  longitude: number,
  timestamp: ServerValue.TIMESTAMP,
  accuracy?: number,
  address?: string,
  updatedBy?: string,
  projectionRevision: number
}
```

`manual` pairs with `pickup`; `auto` pairs with `live`. A retryable Function
re-reads all current sources, validates their live authority, chooses the newest
valid live source with a deterministic ownership tie-break, and falls back to the
canonical pickup only when no valid live leaf remains. Projection leases and
monotonic revisions prevent a delayed trigger from overwriting newer state. No
client may write the projection or its private revision state.

## Passenger presentation

- A manual pickup point is a fixed destination. It remains actionable without being labelled live.
- An automatic live point is `live` for four minutes (covering the three-minute foreground cadence), `recent` until ten minutes, and stale until thirty minutes.
- A point with reported accuracy worse than 500 metres remains visible for context but is not actionable.
- A stale live point may remain visible for context but cannot launch directions or calculate travel metrics.
- At thirty minutes, live coordinates expire from the passenger presentation.
- Far-future, malformed, explicitly withdrawn, and missing records are unavailable.
- Freshness is recalculated every 30 seconds; it does not depend on another Firebase update or render.
- Removing the Firebase record immediately clears passenger state. Snapshot deletion must never leave the old marker in memory.

Passenger location is optional. Opening Find My Bus checks existing foreground permission without prompting. The driver point still renders when passenger permission is absent. The passenger chooses the location control to request permission for distance, travel estimate, and two-point recentering.

## Driver lifecycle

- Manual "Set pickup" publishes `mode: pickup`.
- Foreground auto-share publishes `mode: live` at most once every three minutes and prevents overlapping work within the same lifecycle.
- Enabling auto-share verifies permission before persisting the preference.
- Starting auto-share creates only the lifecycle-owned live leaf. Disabling it compare-deletes only that exact leaf; the independent pickup remains available to the projector.
- A failed withdrawal leaves auto-share enabled and exposes a retry action; the UI must not claim sharing stopped before the remote record is removed.
- Backgrounding, disabling, reassignment, logout, or unmount immediately withdraws the exact live session owned by that screen lifecycle. Firebase `onDisconnect` removal is armed before every live write as a second path.
- Every auto-share lifecycle owns a unique session. Cancellation is checked after native location capture and again after the service write; an older cleanup can never remove a newer session.
- A scheduled backend cleanup queries `driver_location_sessions/cleanupAtMs` in bounded batches and compare-deletes only the exact expired lifecycle, then reconciles each affected tour. This caps precise-coordinate retention even if both client cleanup paths fail.
- The driver reconciles the persisted server timestamp through a realtime subscription; local device time is never presented as authoritative publication time.
- Manual previews are bound to the tour and driver identity active at capture time. Assignment changes invalidate the preview, and reverse-geocode results are applied only to the matching request.

## Passenger delivery

- Connectivity comes from Firebase `.info/connected`; a cached driver snapshot does not cause a false `Connected` label while offline.
- Subscription errors expose an explicit retry action.
- Initial and duplicate or replayed snapshots do not trigger update haptics; only a changed publication after the initial snapshot does.
- Live and fixed pickup markers use different labels. Stale and low-accuracy points cannot launch directions or calculate distance or ETA.

## Session cleanup and legacy compatibility

Logout, policy cleanup, assignment change, and account deletion query raw source
records by exact `appSessionId`, compare-delete only those records, and reconcile
the affected projections. Ending handset A therefore cannot remove handset B.

Existing `tours/{tourId}/driverLocation` records remain readable by the unchanged
passenger contract during cutover. They are not promoted into trusted schema-v2
sources because legacy records do not contain enough session ownership to prove
authority. The first trusted source reconciliation replaces that compatibility
snapshot. A fixed pickup that must persist must be republished by a currently
authorised driver; migration must never invent an Auth UID or app session. Old
clients that still write the shared path are intentionally denied after the new
rules cutover, so Functions and rules must be ready before releasing the 1.0.5
mobile binary.

## Verification

```text
npm run test:mobile:ux
npm run test:functions:scripts
npm run test:web-admin
npm run test:emulators
```

Changes to assignment cleanup or the versioned record validation require Functions and Realtime Database rules deployment before the corresponding mobile release.
