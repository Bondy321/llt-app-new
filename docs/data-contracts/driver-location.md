# Driver Location and Find My Bus Contract

Date: 13 August 2026

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
  accuracy?: number,
  address?: string,
  updatedBy?: string
}
```

`manual` must pair with `pickup`; `auto` must pair with `live`. Coordinates, accuracy, text lengths, allowed fields, and the resolved server timestamp are bounded by Realtime Database rules. Legacy unversioned records remain writable during the mobile rollout, but all new code writes the strict schema.

## Passenger presentation

- A manual pickup point is a fixed destination. It remains actionable without being labelled live.
- An automatic live point is `live` for two minutes, `recent` until ten minutes, and stale until thirty minutes.
- A stale live point may remain visible for context but cannot launch directions or calculate travel metrics.
- At thirty minutes, live coordinates expire from the passenger presentation.
- Far-future, malformed, explicitly withdrawn, and missing records are unavailable.
- Freshness is recalculated every 30 seconds; it does not depend on another Firebase update or render.
- Removing the Firebase record immediately clears passenger state. Snapshot deletion must never leave the old marker in memory.

Passenger location is optional. Opening Find My Bus checks existing foreground permission without prompting. The driver point still renders when passenger permission is absent. The passenger chooses the location control to request permission for distance, travel estimate, and two-point recentering.

## Driver lifecycle

- Manual “Set pickup” publishes `mode: pickup`.
- Foreground auto-share publishes `mode: live` at most once every three minutes and prevents overlapping capture/upload runs.
- Enabling auto-share verifies permission before persisting the preference.
- Disabling auto-share transactionally removes only a live record, preserving a manual pickup point if one exists.
- A failed withdrawal leaves auto-share enabled and exposes a retry action; the UI must not claim sharing stopped before the remote record is removed.
- Auto-share is foreground-only. When the screen is inactive, the last live record naturally becomes stale and expires in passenger presentation.
- Every auto-share run captures the effect's tour/auth lifecycle scope. Reassignment, logout, disable, or unmount revokes that scope; cancellation is checked after native location capture and again at the service write boundary, so a late capture cannot republish coordinates to the former tour.

## Verification

```text
npm run test:mobile:ux
npm run test:functions:scripts
npm run test:web-admin
npm run test:emulators
```

Changes to assignment cleanup or the versioned record validation require Functions and Realtime Database rules deployment before the corresponding mobile release.
