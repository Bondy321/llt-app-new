# Driver Location and Find My Bus Contract

Date: 28 August 2026

Passengers continue to read the server-owned compatibility projection at
`tours/{tourId}/driverLocation`. Clients cannot write or remove that projection.

## Private sources

Foreground live sharing remains installation-lifecycle owned:

```text
driver_location_sessions/{appSessionId}|{liveSharingSessionId}
```

Its schema-v2 record contains exact `authUid`, `appSessionId`, `driverId`,
`tourId`, `liveSharingSessionId`, bounded coordinates and accuracy, a server
timestamp, and `cleanupAtMs`. The handset arms `onDisconnect` before writing.
Logout, role/session replacement, unmount, backgrounding, and disabling sharing
compare-delete only the exact live leaf.

A manual fixed pickup is assignment owned, not installation owned:

```text
driver_location_pickups/{tourId}
```

```ts
{
  schemaVersion: 1,
  isSharing: true,
  source: 'manual',
  mode: 'pickup',
  driverId: string,
  tourId: string,
  assignmentRevision: number,
  latitude: number,
  longitude: number,
  accuracy?: number,
  address?: string,
  updatedBy?: string,
  timestamp: number,
  publishedAtMs: number,
  expiresAtMs: number
}
```

The pickup never contains `authUid` or `appSessionId`. All client reads and
writes at this root are denied. `updateDriverLocationPickup` is the only mobile
mutation boundary. It validates Firebase Auth, the exact current app session,
an explicitly materialised stable driver policy, the current driver/tour and
manifest assignment, and the assignment revision while holding the same sorted
driver/tour locks used by assignment. It then stamps the private record from
server-owned state. Withdrawal compare-deletes only the same driver, tour, and
assignment revision.

The pickup therefore survives logout, app-session refresh, another handset, and
a creator role change while the assignment remains current. Reassignment,
unassignment, and tour deletion clear the source under their server-owned
operation. The scheduled location cleanup also queries `expiresAtMs` in bounded
batches, compare-deletes the exact expired publication, and reconciles the tour.
Expiry is thirty days after the later of publication or indexed tour end, capped
at 400 days after publication.

## Projection and rollout

The projector validates every current source, chooses the newest valid live
source with a stable ownership tie-break, and otherwise uses the valid pickup.
The public schema remains:

```ts
{
  schemaVersion: 1,
  isSharing: boolean,
  mode?: 'pickup' | 'live',
  source?: 'manual' | 'auto',
  latitude?: number,
  longitude?: number,
  timestamp: number,
  accuracy?: number,
  address?: string,
  updatedBy?: string,
  projectionRevision?: number
}
```

Projection leases prevent concurrent regressions. Rollout state is private and
explicit at `live_state_rollout/v1`:

```ts
{
  schemaVersion: 1,
  phase: 'compatibility' | 'cutover',
  projectionRevision: number,
  updatedAtMs: number
}
```

A server projection re-reads the rollout record immediately before publishing.
If phase or rollout revision changed during source validation, it publishes
nothing and lets the retryable trigger recompute against the current phase.

Missing state means compatibility. In compatibility, old shared-path writes
remain available and the server does not add `projectionRevision` to the public
shape. A source write never changes rollout phase. Only the authenticated admin
rollout endpoint can revision-check a phase request. This release refuses every
request to enable cutover with `LIVE_STATE_CUTOVER_PREREQUISITE_NOT_MET`; therefore
mixed 1.0.4/1.0.5 operation remains in compatibility. The cutover schema and rules
remain characterized for future readiness, but are not an available operation.

In the future-characterized cutover phase, trusted pickup requests below mobile
1.0.5 receive HTTP 426 with `UPDATE_REQUIRED`. An untouched 1.0.4 binary writes
RTDB directly and can receive only Firebase permission denied. A future change
must add a prior client mapping capability or prove no supported legacy clients
remain before enabling that phase.

## Passenger and driver presentation

- A pickup is an actionable fixed destination and is never labelled live.
- A live point covers the three-minute cadence, becomes non-actionable when stale
  or worse than 500 metres accuracy, and disappears after thirty minutes.
- Passenger location permission is optional; it is requested only when the
  passenger chooses to show or refresh their own position.
- Firebase `.info/connected` supplies connection truth. Snapshot deletion clears
  old markers, subscription failure has a retry action, and only a changed
  publication after the initial snapshot triggers update haptics.

## Verification

```text
npm run test:mobile:ux
npm run test:functions:scripts
npm run test:emulators
npm run test:contracts
```
