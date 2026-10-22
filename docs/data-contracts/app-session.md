# App Session Data Contract

## Purpose

`app_sessions/{authUid}` is the only authority that turns a persistent Firebase Auth account into a currently authorised mobile-app session. Firebase Auth, a passenger participant row, a driver identity mapping, an assignment, or a push token is never sufficient on its own.

Normal logout deliberately preserves the Firebase Auth UID and opaque passenger binding. Each phone can independently verify the same booking reference/email and receive its own app session, sharing the booking's stable passenger principal. Private version-2 device authorizations are additive; logout or revocation of one session does not affect another phone. Legacy single-UID records are atomically promoted on verified login, while explicit security locks remain enforced. See the [stable identity contract](../stable-identity-rollout-checklist.md).

## Canonical session

Only Admin SDK code may create, rotate, update, revoke, or delete this record:

```json
{
  "schemaVersion": 1,
  "sessionId": "sess_v1_0123456789abcdef0123456789abcdef",
  "authUid": "firebase-auth-uid",
  "principalId": "pax_v2_... or driver:D-...",
  "principalType": "passenger or driver",
  "tourId": "normalised-tour-id or null",
  "driverId": "D-... or null",
  "driverLoginPolicyGeneration": "driver sessions only; non-negative integer",
  "status": "active",
  "issuedAtMs": 123,
  "lastAuthenticatedAtMs": 123,
  "expiresAtMs": 456,
  "sessionRevision": 1
}
```

Invariants:

- `authUid` equals the path UID.
- `sessionId` is a server-generated `sess_v1_` value followed by 32 lowercase hexadecimal characters.
- Passenger `principalId` is a server-issued opaque `pax_v2_` identity. It contains no booking data or other personal data.
- Driver `principalId` is exactly `driver:{driverId}`.
- Passenger and assigned-driver sessions normally expire after 12 hours. A valid unassigned-driver session expires after one hour. Every TTL is bounded between five minutes and 24 hours.
- Clients may read only their own record and cannot write any field.
- `driverLoginPolicyGeneration` is server-only and binds driver sessions to the current device-policy generation. Legacy generation-less driver sessions are generation zero only before the first policy record is written.
- `app_session_locks`, `app_session_events`, and
  `app_session_role_claim_jobs` are server-private.
- `account_deletion_active/v1/{authUid}` is a separate non-expiring server-owned barrier. Session
  issuance fails closed with `ACCOUNT_DELETION_IN_PROGRESS` whenever it is present or malformed. A
  permanent hashed `account_deletion_uid_tombstones/v1/{uidHash}` fence also rejects stale tokens after
  Auth deletion. Passenger issuance additionally holds and checks the hashed-booking
  `account_deletion_passenger_locks`/`account_deletion_passenger_active` boundary before identity
  authorization and again before its atomic write.

## Role transitions

Session issuance owns role transition; persistent profile data is never allowed to
decide the current role. Issuing a passenger session atomically clears
`users/{authUid}/driverId`, `driverPrincipalId`, and `driverAssignedTourId` in the
same RTDB root update that installs the passenger session, durable passenger
identity, and an exact-session job under
`app_session_role_claim_jobs/v1/{authUid}`. A retryable worker then removes every
known legacy driver-authority custom claim from Firebase Auth and compare-deletes
the job only if the same passenger session is still current. A stale job is
discarded without touching a replacement session. This process does not delete
`drivers/{driverId}`, operational assignment history, the opaque passenger
identity, or private-photo ownership.

Issuing a driver session preserves those durable passenger fields. A failed RTDB
root update changes neither role and never starts the Auth claim update. If Auth is
temporarily unavailable after a successful passenger transition, RTDB remains the
current-role authority, the login returns `ROLE_TRANSITION_IN_PROGRESS`, and the
job remains retryable for its bounded 30-day retention window. Repeated
passenger-to-driver-to-passenger
transitions therefore preserve durable identity while all driver-only rules bind
directly to the active driver app session, current policy generation, user mapping,
and exact manifest assignment; legacy custom claims never grant RTDB authority.

## Passenger membership

The passenger verifier atomically issues the app session and replaces the matching participant row:

```json
{
  "schemaVersion": 2,
  "userId": "firebase-auth-uid",
  "principalId": "pax_v2_...",
  "sessionId": "sess_v1_...",
  "sessionExpiresAtMs": 456,
  "joinedAtMs": 123,
  "lastAuthenticatedAtMs": 123
}
```

Every passenger-sensitive rule checks the current session's status, tour, principal, expiry and session ID against this row. A stale participant row is therefore inert. Mobile `joinTour` is a read-only compatibility check and cannot create membership.

## Driver authority

Driver tour access requires all of the following to agree:

- active, non-expired `app_sessions/{authUid}` driver session;
- session `driverId`, `principalId`, and `tourId`;
- `users/{authUid}/driverId` and current assigned tour;
- current `driver_login_policy/v1` generation;
- `drivers/{driverId}/authUid` only while single-device enforcement is enabled;
- `tour_manifests/{tourId}/assigned_drivers/{driverId}`.

An operational assignment remains after logout but cannot grant mobile access. With enforcement off, several verified handsets may hold independent sessions for the same driver. The server-owned assignment mutation finds every active current-generation driver session and updates each session revision, authentication time, bounded expiry, user assignment helper, and notification-device operational tour. With enforcement on it preserves only the claimed UID and queues exact cleanup for obsolete sessions. See `driver-login-policy.md` and `driver-assignment.md`.

## Session state transitions

```text
verified login -> active session -> user logout / admin revoke / expiry -> no session
                         |-> assignment change -> rotated revision, same session ID
```

Issuance, assignment, logout, revocation, and expiry cleanup use the transactional
lock at `app_session_locks/{authUid}` (normally 30 seconds; issuance holds a
three-minute lease). The lock-root reservation admits an operation. Acquisition
for a session mutation then advances the existing canonical session's
`sessionRevision` in a bounded session-node transaction and records that exact
session/revision in its lease. Assignment admission, notification-device,
role-claim and tracking/pickup operations retain the current revision; assignment
advances its revision atomically with its notification projection. Registration
must not invalidate its own submitted session revision or trigger a loop.
Missing sessions remain absent. This revision advance is an authority fence,
not a tour assignment or permission to restart tracking. Supported clients accept
a higher revision with the same session/principal/tour without ending the session.
A lock can be released only by its opaque owner; an expired lock can be recovered.
Renewal cannot revive an expired owner or a different canonical session/revision.
Expiry and policy cleanup supply their captured expected session ID before any
revision advance; expiry also supplies its observed revision. A stale candidate
leaves the successor record unchanged so its notification registration remains
coherent. Exact-session logout/revoke admissions use the same condition. Stop and
other non-mutating admissions can read missing, malformed or inactive canonical
state without creating or repairing authority; their own domain still requires
exact retained proof before retiring any publication.
Passenger and driver login handlers declare a 60-second timeout; their
three-minute issuance lease exceeds that invocation deadline. Issuance renews
after its final barrier reads and checks the live clock again immediately before
dispatching its atomic authority update. That root update retains the existing
atomic issuance contract; it is not an independently compare-and-set root write.
An arbitrary delayed in-flight issuance update beyond its lease remains a
separate limitation, unlike the cleanup CAS which rejects arbitrary stale resumes
at the actual mutation boundary.

Cleanup compares the captured complete authority, fenced revision and live lease
expiry inside the canonical session transaction. It first marks the captured
record `ending` (never valid active authority), then cleans exact owned leaves,
and finally compare-deletes the canonical record with the same fence. A resumed
expired worker cannot delete a replacement, including during the interval before
a successor installs its revision fence: a legitimate takeover can occur only
after the captured old lease expires, and the callback checks that absolute expiry
against the live clock. An incomplete `ending` record retains its scope and
expiry for exact retries. Expiry and policy workers acquire each lease from the
current clock rather than reusing the batch query time.
After owned leaves are reconciled, cleanup persists its captured old-session audit
event before the final deletion. Production event keys are deterministic hashes
of that session, event type and reason; retries preserve the first timestamp and
cannot duplicate the event. An audit write failure therefore retains `ending`
retry scope. Such an event records retirement of the captured old authority; it
never identifies a replacement session as expired or ended.

Issuance atomically tags `users/{uid}/appSessionId`, passenger access grants'
`sessionId`, and an existing notification device's `authoritySessionId` with the
new session, and installs its new canonical session/revision in the held lock.
Profile token cleanup, grants, membership and device eligibility use bounded
exact-owner transactions. An expired worker can therefore finish or retry old
leaf cleanup without damaging a replacement's authority. Untagged legacy UID
read/live rows and grants are conservatively retained when their exact session
owner cannot be established; they confer no authority without a valid current
session. Canonical principal/read history and sibling-device authority remain
preserved. The pure atomic cleanup-update builder remains reserved for workflows
which already own a stronger serialized reservation, including account deletion
and session replacement; asynchronous ordinary cleanup uses the fenced protocol.

`endAppSession` requires Auth, `POST`, `reason=user_logout`, and the exact expected session ID. App Check is currently explicitly disabled. A missing session is idempotent success. A different current session returns `SESSION_CHANGED`, so a delayed Session A logout cannot end Session B.

Cleanup removes exact-owned session authority and ephemeral state: the session,
passenger membership and tagged grants, per-session typing/presence sources,
tagged UID read markers and migration requests, live tracking, owned location
sources, and operational push eligibility. Untagged legacy leaves follow the
conservative preservation rule above. Location and chat projections are
reconciled after owned sources are removed. It preserves identity bindings,
booking and manifest records, operational driver assignment, marketing consent,
historical content, reports, photos, reactions, and canonical read history.

## Account deletion boundary

Account deletion is not `endAppSession` with additional client writes. The authenticated
`requestAccountDeletion` workflow validates the exact current session, derives trusted role/identity
scope, and atomically installs a durable private job, queue entry and non-expiring login barrier before
destructive work. The captured session is revoked during reservation; all later phases use stored
server-derived scope and remain resumable after the original Firebase Auth user is removed.

Passenger and driver session issuance check the barrier at the same serialized authority boundary used
for session creation. No new session may race or replace an accepted deletion. Missing rollout state is
compatibility, malformed rollout state fails closed, and `server_only` is reserved for a separate later
cutover.

Normal logout preservation remains unchanged. Explicit deletion additionally compare-removes the
captured passenger binding/security UID or driver scalar, UID account/log/notification records and
trusted passenger-owned active-tour content, while preserving bookings, booking identity metadata,
tours/manifests, legal/accounting/operational records, driver profiles/assignments, assignment-owned
pickups and shared driver-principal content. Auth deletion is last. The canonical contract is
[`account-deletion.md`](./account-deletion.md).

## Mobile behavior

The safe session subset is stored at `@LLT:appSession:v1`; it contains no credentials. Startup validates it and subscribes to its own server record. Missing, replaced, revoked, or expired state locks and purges the app.

Logout is two-phase:

1. Persist the exact pending session-end request before network I/O.
2. Call `endAppSession` with Firebase Auth and `expectedSessionId`; attach App Check only when its rollout is enabled.
3. Only confirmed idempotent server success permits the normal logged-out state.
4. Offline or transient failure enters the blocking `LogoutPendingScreen`; no tour UI is restored. Retry survives a force-close.
5. `SESSION_CHANGED` cannot clear a newer session and requires secure reauthentication.

Local cleanup stops replay and removes scoped tour packs, offline actions and local photo assets, driver operational caches, notification and photo-viewer caches, safety/trusted-contact data, logs, and persisted identity/session keys. Cleanup failures are reported rather than silently treated as complete.

## Media and notifications

All direct client reads and writes under `group_tour_photos/**` and `private_tour_photos/**` in Firebase Storage are denied. The mobile service sends Auth to server endpoints for upload, delete, and short-lived URL resolution, and may add App Check after its future rollout. Each refresh rechecks the active session and current tour authority. RTDB photo records contain Storage paths, not durable Firebase download URLs.

Operational notification selection requires an active matching app session in addition to a participant or driver assignment, and logout authoritatively marks the profile push token unavailable. Marketing delivery still requires consent and an active token, so an ended session is not eligible.

## Operations

The admin Drivers view reads the server-owned session for the selected Auth UID and displays only a masked session ID plus role, tour, issue/expiry time, and revision. `revokeAppSession` is admin-authenticated, compares an optional expected session ID, supports only allowlisted reasons, and uses the same cleanup and lock path as logout.

The scheduled `cleanupExpiredAppSessions` job runs every 15 minutes, processes at most 50 expired sessions per run, and removes at most 100 expired 30-day audit events. Rules still deny expired sessions immediately; the job is data hygiene, not the revocation boundary.

## Mobile reconciliation of driver revisions

The own-session listener and driver-assignment HTTP result share one application reconciliation
path. A transition must retain the installation, session ID, original issue time, role, principal
and driver ID, pass canonical session validation, and advance `sessionRevision`. A changed driver
tour (including `null` for unassigned) is permitted only through that path. Passenger tour changes,
same-revision mutations, ended/expired sessions and replaced identities still revoke. Older
revisions and duplicate responses cannot restore an old assignment. Server policy generation and
assignment rules remain authoritative for every operational read/write; local projections grant
no access.

The listener schedules expiry from its most recently accepted revision immediately, before
asynchronous tour loading. An old timer callback checks that accepted expiry. Revision-only updates
on the same operational scope retain tracking, replay, visible route and tour projections.
Passenger same-tour revisions likewise update the active React authority and persisted session
monotonically, without changing membership, another handset or the displayed trip.

For an actual tour change, the application fences old replay and explicit tracking immediately,
removes the visible old tour scope, and retires exact old-tour caches/actions. Tracking requires a
new explicit Start; old samples and queued actions are never relabelled. Once retirement and strict
tour/departure loading succeed, the session and booking/tour/navigation seed are written in one
serialized storage batch. Only the newest accepted revision and still-current installation may
activate that projection. Storage or retirement failure leaves the new tour unavailable and
retryable; it is not reported as successful reconciliation. Logout waits for captured retirement
before completing local cleanup.
Failed retirement is retried through the same captured purge path for both user logout and remote
revocation; it does not require another server session event. Retries retain the exact session ID,
coalesce their retirement work and reject changed installation/session ownership. Logout drains
accepted projection storage batches, following a changing reconciliation tail before clearing local
keys, so a late assignment cannot restore a cleared seed.
That drain has a total 15-second deadline, including an uncached tour read or stalled storage task.
Timeout retains the captured authority and task tail and keeps logout retryable; it cannot admit a
new login or allow the timed-out continuation to clear keys. Revocation callbacks also check the
latest installation/session authority before acting, including the render-to-passive-cleanup gap.

Driver navigation persistence uses that same serialized adapter and rejects old captured session
or tour seeds. Cold startup may accept a newer same-driver revision verified from the server and
rebuild its saved assignment projection from the authoritative tour. It cannot infer assignment
from a profile helper or use an expired cached session.
Cold restore retires the exact previous tour's queue/cache and interrupted tracking before exposing
the verified new tour. A retirement/load failure preserves the previous seed and blocks normal
session listeners behind startup Retry until that cleanup and restoration succeed.

`tests/driverSessionReconciliation.test.js` exercises the real listener, application runner and
mounted logout lifecycle with external adapters, including event/HTTP ordering, removal, stale
results, installation/identity replacement, expiry, restore and guarded persistence.

### Fresh login and subscription ownership

Driver activation first installs the verified `driverId` in the local identity
projection, with tour scope withheld. The login attempt captures the installation,
previous authority and operation generation before its first asynchronous phase;
a superseded preparation cannot activate. Login storage commits are guarded inside
the serialized adapter as well as at the application continuation boundary.

An unchanged initial own-session event defers assignment projection while that
same login is preparing or saving its seed. The listener remains active: higher
revisions are accepted and reconciled immediately, and remote deletion,
replacement and current accepted expiry can still retire the captured session.
Subsequent login phases require the captured session, principal, installation and
revision to remain current. A save callback captured with a null session must
supply explicit verified authority; it cannot fall through to an unguarded driver
seed write. Once a login's tour is exposed, its booking ID is the verified driver
ID and its persisted tour/booking seed has already committed.

A higher assignment can finish while login awaits onboarding, identity work or a
cache write. The old login must not restore its original projection or route.
Its still-owned onboarding decision is applied to the accepted session without
rewriting the old booking/tour seed. Assignment reconciliation preserves an active
notification-onboarding route through an explicit pending intent cleared by the
real completion runner. Completion while login diagnostics or route storage is
pending cannot reopen onboarding; a pending assignment seed does not leave login
permanently in its preparing phase. A login cache write already in progress is included
in the bounded retirement drain before its old-tour cache is purged; logout also
awaits that captured login task. This drain does not claim to serialize every
storage writer: an already-issued independent navigation batch can still recreate
booking/tour seed keys after cleanup while the app-session key remains absent.
That incomplete local-data-removal case remains a separate tracked follow-up.

The mounted logout subscription owns a separate generation from operational
retirement. Failed assignment retirement followed by duplicate-event repair does
not invalidate revocation callbacks for the still-current subscription. Callbacks
also check the latest session identity, installation, lifecycle state and disabled
state, including the render-to-passive-cleanup interval. A genuine current-session
null, expiry or replacement invokes the real captured local-cleanup path; stale
subscriptions cannot clear successor authority.
Expiry events include their triggering authority. An obsolete lower deadline
cannot revoke an HTTP-renewed same-session authority before React runs passive
subscription cleanup, whereas a newly observed expired higher revision remains
actionable. The synchronous logout-status ref is updated with every displayed
status transition, preserving the active fence during React batching and allowing
a verified new login after the previous logout completes.

The additional mounted cases in `tests/driverSessionMountedLifecycle.test.js`
exercise fresh null booking/tour state, initial duplicates, intervening revisions,
first assignment, notification onboarding, pre-activation supersession, logout,
remote revocation and expiry, duplicate repair and renewed timers. They use the
production login runner, session service, reconciliation, guarded save and local
cleanup implementations with controlled external adapters, and assert both React
scope/route and persistent session/projection removal.
