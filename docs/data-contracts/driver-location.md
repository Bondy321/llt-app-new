# Driver Location and Find My Bus Contract

Date: 23 August 2026

The canonical shared driver point lives at:

```text
tours/{tourId}/driverLocation
```

Only an assigned, verified driver or operations admin may publish or remove this record. Driver reassignment and unassignment clear the previous location in the same authoritative multi-path update so a new driver never inherits another driver's point.

## Versioned record

New mobile clients publish schema version 1:

```ts
{
  schemaVersion: 1,
  isSharing: true,
  mode: 'pickup' | 'live',
  source: 'manual' | 'auto',
  latitude: number,
  longitude: number,
  timestamp: ServerValue.TIMESTAMP,
  sessionId?: string,        // required for source: auto
  cleanupAtMs?: number,      // required for source: auto; 30-minute lease
  fallbackPickup?: Pickup,   // prior fixed point while source: auto
  accuracy?: number,
  address?: string,
  updatedBy?: string
}
```

`manual` must pair with `pickup`; `auto` must pair with `live`. New auto publications own an opaque session and a server-validated 30-minute cleanup lease. Coordinates, accuracy, lease bounds, session format, text lengths, allowed fields, and the resolved server timestamp are bounded by Realtime Database rules. Legacy unversioned records remain writable during the mobile rollout, but all new code writes the strict schema.

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
- Starting auto-share transactionally carries forward the current validated manual pickup point as a nested fallback. Disabling auto-share transactionally replaces only the exact live session with that fixed point.
- A failed withdrawal leaves auto-share enabled and exposes a retry action; the UI must not claim sharing stopped before the remote record is removed.
- Backgrounding, disabling, reassignment, logout, or unmount immediately withdraws the exact live session owned by that screen lifecycle. Firebase `onDisconnect` removal (or fixed-point restoration) is armed after every live write as a second path.
- Every auto-share lifecycle owns a unique session. Cancellation is checked after native location capture and again after the service write; an older cleanup can never remove a newer session.
- A scheduled backend cleanup queries the indexed `driverLocation/cleanupAtMs` lease in bounded batches and transactionally removes only the exact expired session, restoring a validated fixed point when present. This caps precise-coordinate retention even if both client cleanup paths fail.
- The driver reconciles the persisted server timestamp through a realtime subscription; local device time is never presented as authoritative publication time.
- Manual previews are bound to the tour and driver identity active at capture time. Assignment changes invalidate the preview, and reverse-geocode results are applied only to the matching request.

## Passenger delivery

- Connectivity comes from Firebase `.info/connected`; a cached driver snapshot does not cause a false `Connected` label while offline.
- Subscription errors expose an explicit retry action.
- Initial and duplicate or replayed snapshots do not trigger update haptics; only a changed publication after the initial snapshot does.
- Live and fixed pickup markers use different labels. Stale and low-accuracy points cannot launch directions or calculate distance or ETA.

## Verification

```text
npm run test:mobile:ux
npm run test:functions:scripts
npm run test:web-admin
npm run test:emulators
```

Changes to assignment cleanup or the versioned record validation require Functions and Realtime Database rules deployment before the corresponding mobile release.
