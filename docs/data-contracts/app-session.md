# App Session Data Contract

## Purpose

`app_sessions/{authUid}` is the only authority that turns a persistent Firebase Auth account into a currently authorised mobile-app session. Firebase Auth, a passenger participant row, a driver identity mapping, an assignment, or a push token is never sufficient on its own.

Normal logout deliberately preserves the Firebase Auth UID and the opaque passenger binding so the same installation can log in again without weakening second-device replay protection.

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

Issuance, assignment, logout, revocation, and expiry cleanup serialize through the transactional 30-second lock at `app_session_locks/{authUid}`. A lock can be released only by its opaque owner and an expired lock can be recovered.

`endAppSession` requires Auth, `POST`, `reason=user_logout`, and the exact expected session ID. App Check is currently explicitly disabled. A missing session is idempotent success. A different current session returns `SESSION_CHANGED`, so a delayed Session A logout cannot end Session B.

Cleanup removes session-derived authority and ephemeral state: the session, passenger membership and legacy grants, per-session typing/presence sources, legacy UID read markers, migration requests, live tracking, exact owned driver-location sources, and operational push eligibility. Location and chat projections are reconciled after exact owned leaves are removed. It preserves identity bindings, booking and manifest records, operational driver assignment, marketing consent, historical content, reports, photos, reactions, and canonical read history.

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
