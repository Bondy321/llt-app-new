# Driver Assignment Data Contract

Use this contract for all driver-to-tour assignment writes (Functions + web-admin).

## Canonical nodes involved

- `drivers/{driverId}`
- `tours/{tourId}/driverId`
- `tours/{tourId}/driverName`
- `tours/{tourId}/driverPhone`
- `tour_manifests/{tourId}/assigned_drivers/{driverId}`
- `tour_manifests/{tourId}/assigned_driver_codes/{driverId}`
- `users/{authUid}/driverId`
- `users/{authUid}/driverPrincipalId`
- `users/{authUid}/driverAssignedTourId`
- `users/{authUid}/principalType`

Only the `assignDriverToTour` Function may write the canonical mutation. It applies
one Admin SDK multi-path update after every lock, revision, policy, and
idempotency check succeeds.

Each driver has at most one canonical active assignment, stored in `drivers/{driverId}/currentTourId`. Reassignment removes stale manifest and tour display links in the same update. The web admin UI must describe this as a single assignment, not as a multi-tour list.

## Canonical payload shape

```ts
interface AssignedDriverCodeRecord {
  driverId: string;    // canonical driver key, e.g. "D-BONDY"
  tourId: string;      // sanitized Firebase key, e.g. "5112D_8"
  tourCode: string;    // human-readable code, e.g. "5112D 8"
  assignedAt: string;  // ISO timestamp, e.g. "2026-02-01T10:15:00.000Z"
  assignedBy: string;  // actor key/uid
}
```

## Validation requirements

- `driverId`: required, must match the `{driverId}` path segment.
- `tourId`: required, sanitized Firebase-safe key.
- `tourCode`: required non-empty display code.
- `assignedAt`: required ISO datetime with timezone.
- `assignedBy`: required non-empty actor identifier.

## Producers and authority

- Mobile calls the authenticated `assignDriverToTour` HTTPS Function through
  `services/bookingServiceRealtime.js`; it does not write assignment paths directly.
- The same endpoint supports an authenticated operations-admin `assign` or
  `unassign` request with expected driver/tour revisions and an idempotency key.
- The Function validates mobile self-assignment or operations-admin authority,
  rejects inactive/conflicting tours, acquires driver/tour locks in sorted order,
  re-reads the canonical roots, and rejects stale revisions before building the
  shared mutation.
- Web admin may read assignment context and revisions for display, but calls this
  endpoint and never emits canonical assignment field writes.

The durable transition key is derived from the hashed actor plus hashed
idempotency key; the semantic request hash is stored separately. Replay with the
same actor/idempotency key and matching request hash returns the stored result.
Reuse with different input is `IDEMPOTENCY_CONFLICT`. Stale inputs,
already-changed assignments, lock contention, and durable continuation are
reported with distinct reason codes; none is silently treated as success.

Transition creation is a create-if-absent transaction. A bounded reservation
records the deterministic policy admission and every affected driver before any
durable barrier is acquired, and each phase uses a single-worker lease. This
prevents concurrent copies of the same first request from advancing the same
phase or orphaning an admission. Assignment admissions and driver barriers do
not expire while work is incomplete; only explicit completion, terminal failure,
or expired reservation recovery releases them.

## Handset and notification reconciliation

With single-device enforcement off, the backend queries every active,
current-generation session for the affected driver(s). It rotates each session
revision, updates tour and bounded expiry, updates the matching user assignment
helper, and changes only the operational fields of `notification_devices`; token
state and valid marketing consent are preserved.

With enforcement on, only the currently claimed UID is reconciled. Other sessions
receive exact-session cleanup jobs. Location and chat raw sources owned by every
reconciled old scope are removed and their projections are recomputed after the
canonical assignment update. Before that update, the transition acquires the
shared location-projection invalidation lease for every affected tour and installs
each reserved-revision tombstone in the same root update. A busy projector makes
the transition retry without committing assignment state, so a paused older
projector cannot republish pre-assignment location authority.

If the handset set is above the synchronous mutation bound, a server-private
`driver_assignment_transitions/v1/{transitionId}` record exposes resumable progress.
The endpoint never reports success after a partial authority update.

Admin replacement treats both `tours/{tourId}/driverId` and every true
`tour_manifests/{tourId}/assigned_drivers/*` entry as affected incumbents. All
such driver profiles, manifest entries, sessions, and barriers are reconciled;
stale manifest-only incumbents cannot survive the replacement.

## Driver manifest authorization

Drivers update passenger manifest rows through:

`tour_manifests/{tourId}/bookings/{bookingRef}`

Security rules authorize that write when all of the following are true:

1. the active, unexpired app session is directly a driver session for the caller;
2. its principal/driver/tour match the current user mapping;
3. a valid materialised policy and exact session generation match;
4. `drivers/{driverId}/authUid` matches only when enforcement is on;
5. `tour_manifests/{tourId}/assigned_drivers/{driverId}` is `true`;
6. the booking belongs to `{tourId}` by canonical `bookings/{bookingRef}/tourId`.

`verifyDriverLogin` uses policy admission and, when enforced, a per-driver claim
reservation before persisting server-owned driver profile helpers. Clients cannot
claim a driver, change assignment authority fields, add their own manifest
assignment, or mutate the canonical assignment directly.
