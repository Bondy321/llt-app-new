# Driver Location and Find My Bus Contract

Updated: 8 October 2026

Passengers continue to read the server-owned compatibility projection at
`tours/{tourId}/driverLocation`. Current clients never write or remove that
projection; legacy shared-path permissions remain during compatibility below.

## Private sources

Foreground live sharing remains installation-lifecycle owned:

```text
driver_location_sessions/{appSessionId}|{liveSharingSessionId}
```

Its schema-v2 record contains exact `authUid`, `appSessionId`, `driverId`,
`tourId`, `liveSharingSessionId`, bounded coordinates and accuracy, a server
timestamp, and `cleanupAtMs`. The handset arms `onDisconnect` before writing.
For screen-local foreground sources, logout, role/session replacement, unmount,
backgrounding, and disabling sharing remove only the exact live leaf. The canonical key and Firebase rules bind its
ownership. Client reads of private sources are always denied, so publication
uses the `set()` acknowledgement and withdrawal uses direct `remove()`, never
a source read or read-dependent transaction.

The service serializes publication and withdrawal per database instance and
exact source key. A stop request immediately fences queued publications. Scope
guards run after disconnect registration, clock estimation and the write
acknowledgement; a superseded write is removed from its own retired leaf.
Independent live sessions remain independent. Every sharing start needs a fresh
live session ID and the caller must invalidate its scope immediately on stop.
Settled queues release their references; they are not permanent retired-ID stores.

The publication result carries `publicationAcknowledged: true`,
`storedLocation: null`, and an explicitly estimated numeric `timestamp` with
`timestampSource: 'server_estimate' | 'client_estimate'`. Only readable built-in
`.info/serverTimeOffset` metadata is consulted. The stored timestamp uses Firebase
server time, and passengers receive the authoritative time from the projection.
The cleanup lease is built after asynchronous waits rather than before them.
Null, boolean or blank GPS inputs cannot be coerced into valid zero coordinates
or perfect accuracy; genuine zero coordinates remain valid.

`withdrawalAcknowledged: true` means the exact leaf is acknowledged absent,
including an already-absent leaf. It does not prove a record previously existed
or that the asynchronous passenger projection has finished. Disconnect cleanup
is cancelled only after acknowledged removal. Failed deletion retains it;
failed cancellation after successful deletion does not falsify the acknowledgement.
A failed update leaves an earlier accepted source and its disconnect cleanup
intact unless the sharing scope has been stopped.

The legacy foreground-sharing compatibility actions switch updates off immediately, invalidate the generation and
keeps each retired source identity in a pending map through failure and rerender.
Retry deletes those same leaves, including after effect cleanup has cleared the
active session. Preference loading is fenced against subsequent explicit toggles;
an abandoned enable after a scope change restores its saved preference to off.
The enabled preference is bound to its driver and storage key, so a reused
controller pauses immediately while a different driver's preference is loading.
Until confirmed, the status says removal is pending or being
confirmed. Successful removal clears only this session's optimistic local point;
it preserves another handset's public point and the fixed pickup. The map is
screen-local, not durable tracking state: disconnect handling, server authority
cleanup and expiry remain the fallback after unmount or authority loss.

## Explicit background tracking intent

App-owned tracking uses a fresh `track_` live-sharing ID, with 8–80 characters
in the same RTDB-safe identifier alphabet. Its durable server stop fence is private:

```text
driver_tracking_sessions/{appSessionId}|{liveSharingSessionId}
```

```ts
{
  schemaVersion: 1,
  authUid: string,
  appSessionId: string,
  driverId: string,
  tourId: string,
  liveSharingSessionId: string,
  status: 'active' | 'stopped',
  startedAtMs: number,
  expiresAtMs: number
}
```

The client acknowledges the active intent write before starting native location
updates. Creation requires the full current driver/app-session, policy, claim and
assignment authority already required by live locations. The key and identity must
match that authority; start time is within sixty seconds of server time and expiry
equals the current app session's expiry exactly. A compensating absent `stopped`
intent uses the identical creation checks, covering an ambiguous failed start.
Extra fields are denied. This root grants no authority to any other root and clients
cannot read it or delete its records.

Native tracking stops through the authenticated recovery endpoint below. Rules
also permit the owner to PUT the cached exact intent with only `status` changed
to `stopped`, then remove its exact private live source. The record owner may stop
and retry after expiry, reassignment, revocation, policy change or role loss.
Every identity, start and expiry field is immutable, and an existing stopped
record cannot become active again. Owned tracked-source deletion is also allowed
after authority loss; an already-absent leaf needs its exact owner-matching fence
to acknowledge absence. Existing `loc_`/legacy source rules remain unchanged.

Every tracked-source publication needs its matching active, unexpired intent in
addition to normal authority. The projector independently applies the same intent
check, excluding retained stopped/expired sources without exposing private fields.
`projectDriverTrackingSession` re-reads current intent state before retiring an
exact owned leaf and reconciling the tour. Delayed events preserve a newer active
intent, other live session IDs, other handsets and the assignment-owned pickup.

The existing location cleanup schedule queries intent `expiresAtMs` in bounded
indexed batches. It removes expired sources and compare-deletes matching expired
intents. Stopped tombstones persist until their immutable app-session expiry, when
session authority itself prevents delayed callbacks from recreating the source.
Session replacement, logout, revocation and account deletion also query the indexed
`appSessionId`, matching the captured server UID, session, driver and tour. They
retire matching intents before deleting live sources, even when the current profile
or role has changed. They preserve immutable fence metadata until expiry and leave
other installations' intent/source records untouched. The private UID/session/tour
metadata is bounded by original app-session expiry and is never projected publicly.

### Authenticated stop recovery

`stopDriverTrackingSession` is a POST-only mobile endpoint in `europe-west1`.
It uses the same Firebase bearer-token and App Check boundary as app-session and
pickup mutations. Clients supply the exact cached tracking schema directly as
the request body, with `status: 'stopped'`; `authUid` must equal the authenticated
UID. No anonymous sign-in or client read of either private root is needed.

The endpoint transactionally stops an existing exact intent, preserving every
immutable field, then compare-deletes only its matching source and reconciles
the tour before acknowledging withdrawal. Conflicting ownership or identity is
rejected. A matching retained source also proves old ownership when an intent is
missing, even after session expiry, revocation or reassignment.

When both private records are missing under a current active session, missing-fence
creation still requires exact server session identity/expiry, a materialised stable
policy with an explicit matching generation, driver claim, profile and assignment
authority, and no assignment transition. Session and assignment locks protect
this admission check. A stopped recovery intent may preserve an old or future
device-clock start; it cannot activate location updates. Active client creation
retains its sixty-second server-time window.

If both private records are absent and the supplied app session is already expired,
revoked, missing or replaced, the endpoint acknowledges exact source absence
without creating a fence. With no server-owned evidence of the supplied tour, it
does not reproject an arbitrary tour or clear a legacy compatibility location.
This is the `ALREADY_RETIRED` result; all ownership-proven paths reconcile before
returning `STOPPED`. Projection failures leave the stopped fence available for retry
and never return a withdrawal acknowledgment.

```ts
{
  success: true,
  withdrawalAcknowledged: true,
  reason: 'STOPPED' | 'ALREADY_RETIRED',
  sourceRemoved: boolean,
  fencePersisted: boolean,
  stoppedAtMs: number
}
```

Error responses have `success: false` and a reason, never a withdrawal
acknowledgment. Invalid input is HTTP 400, wrong owner is 403, changed state or
lock contention is 409, invalid policy configuration is 503, and an internal or
projection failure is 500. Missing authentication/App Check follows the shared
mobile boundary. The response contains no owner, session, driver or tour metadata.

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

The app-level Task Manager handler publishes only from explicitly saved active
intent in AsyncStorage. It persists no coordinates. Every awaited result is fenced
against the current generation and identity. Samples must be valid, newer than
the session start and no more than ninety seconds old. Server work is limited to
one attempt per minute independently of native delivery cadence. GPS and intent
writes use authenticated HTTP, preventing Firebase's offline coordinate replay;
Auth, token, response and disconnect waits are bounded. An offline Stop persists
stopping intent, shuts down native collection and retains exact cleanup identity.
Cold UI launch retires interrupted tracking and requires a new explicit Start.
Status and Stop remain visible across navigation, logout and deletion surfaces.
The transport checks session validity and sample freshness again after token
retrieval, immediately before dispatch. Serialized intent storage prevents a late
active save from overwriting a Stop that is already in progress.
See [physical device acceptance](../operations/driver-tracking-acceptance.md).

```text
npm run test:mobile:ux
npm run test:functions:scripts
npm run test:emulators
npm run test:contracts
```

`tests/driverLocation.lifecycle.test.mjs` covers serialized races, failed writes,
retry identity, clock estimates and malformed coordinates using write-only fakes.
`tests/driverLocationSharing.behavior.test.js` exercises the real React actions
through stop/retry, rerender, login/assignment changes, background and unmount.
`tests/firebaseRules/driverLocationService.rules.test.js` runs the real service
against the repository rules, verifies unreadable sources, actual server timestamps,
owned deletion/disconnect removal, multi-device isolation, pickup fallback and
projection exclusion after logout, revocation, expiry or reassignment. It invokes
the real projector with trusted emulator access; it does not emulate deployed
trigger delivery or replace physical device acceptance.

`tests/functions.driverTrackingSessions.test.js` characterizes exact intent
matching, delayed stop/delete events and bounded expiry comparisons.
`tests/firebaseRules/driverTrackingSessions.rules.test.js` verifies private reads,
strict creation, compensating stopped creation, immutable stop after authority
loss, acknowledged absence, rejected resurrection and projection exclusion using
trusted emulator access. Deployment and physical-device lifecycle acceptance are
separate release checks.

The mobile controller, native adapter, REST transport and root status tests cover
explicit disclosure, platform permission differences, navigation-independent
ownership, delayed callbacks, interrupted Start, storage/token races, bounded
network waits and stopping across logout/deletion. The tracking service rules
integration uses actual authenticated HTTP, matching the production transport,
and verifies that a stopped fence rejects delayed GPS writes.
