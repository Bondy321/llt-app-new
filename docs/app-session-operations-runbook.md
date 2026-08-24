# App Session Operations Runbook

## What operations can see

In Web Admin, open Drivers and select the driver/mobile identity. The App Session panel shows whether a server session exists, role, assigned tour, issue and expiry times, revision, and a masked session ID. Absence of a session means the persistent Firebase account is not authorised for mobile tour data even if its driver assignment remains.

Never paste a full Auth UID, session ID, ID token, App Check token, booking reference, email, push token, or signed media URL into tickets, chat, screenshots, or logs.

## Revoke a session

Use **End mobile session**, select the closest allowlisted reason, confirm the masked target, and submit. Supported reasons are `lost_device`, `security_review`, `staff_request`, and `account_support`.

Expected result:

- the current exact session is deleted;
- passenger membership and legacy grants are removed when applicable;
- typing, presence, tracking, and matching driver location are cleared;
- push eligibility is disabled;
- historical operational assignment/content and opaque identity binding remain;
- the connected app detects deletion and purges local tour state.

A response of `SESSION_CHANGED` is protective: the person has logged in again since the panel loaded. Refresh and reassess; never retry against an old full session ID. An already-ended response is successful and requires no further deletion.

## User logout support

Normal online logout ends the server session first and then clears local data. If the device loses connectivity, the app displays **Logout pending** and blocks all tour UI. Ask the user to reconnect and tap retry. Do not tell them logout is complete until that screen confirms server revocation and returns to login.

Force-closing the app is safe: the pending request is durable and is retried on launch. A delayed request cannot end a newer login because the exact expected session ID is compared on the server.

## Same-installation and replacement-device behavior

Normal logout does not delete Firebase Auth or the passenger booking-to-device binding. The same installation can log in again and receives the same opaque `pax_v2_` principal with a new `sess_v1_` session. A different Firebase UID remains blocked with `REAUTHORIZE_REQUIRED`.

If a customer genuinely replaces or loses a device, use the existing authorised identity-recovery procedure after revoking the old session. Do not manually copy identity bindings or manufacture an `app_sessions` record.

## Incident checks

For suspected stale access:

1. Confirm whether `app_sessions/{authUid}` exists and is active/non-expired.
2. For a passenger, confirm the tour participant row has schema 2 and the same session ID/principal.
3. For a driver, confirm the session, user mapping, driver Auth UID, current tour, and manifest assignment all agree.
4. Revoke through Web Admin.
5. Confirm push token status is `UNAVAILABLE` with `SESSION_ENDED`.
6. Confirm direct group/private Storage access fails and Function media resolution rejects the ended session.
7. Record only safe timestamps, reason codes, masked IDs, and audit-event hashes.

Do not “repair” access by adding a participant row, access grant, assignment, custom claim, or push token. Only verified login can issue app authority.

## Scheduled cleanup

`cleanupExpiredAppSessions` runs every 15 minutes and handles a bounded 50-session page plus 100 expired audit events. Rules use `expiresAtMs` directly, so an expired session is denied before cleanup runs.

Investigate repeated `failed` or `locked` counts, a growing expired-session backlog, failed driver-location compare-delete events, or 15-minute gaps in scheduler execution. Locks expire after 30 seconds; never delete a live lock merely because an operation is still running.

## Migration operation

The cutover script is dry-run-first and paginated:

```powershell
npm --prefix functions run migrate:app-sessions -- --project=loch-lomond-travel --limit=25
```

Apply requires all three safeguards: `--apply`, exact `--confirm-project`, and `--cutover=FORCE_SECURE_RELOGIN`, plus a unique protected `--backup` path. Continue with returned `afterTour`, `afterUid`, and `afterBooking` cursors until each is null. Stop on `truncatedParents`, a failed post-run audit, unexpected project identity, or any backup creation failure.

The script never creates a session from legacy state. It preserves only exact current session-bound participant/token state; every affected legacy user must complete verified online login after cutover.

## Release smoke matrix

Run after any session/rule/media change:

- Passenger: login, restore, group/private upload and view, logout, same-device re-login, second-UID rejection.
- Driver: unassigned login, assignment, manifest action, location publish, logout without unassignment, post-logout denial.
- Race: Session A logout delayed until after Session B login returns `SESSION_CHANGED` and leaves B active.
- Offline: logout request failure enters blocking pending state, survives relaunch, and completes after reconnect.
- Admin: non-admin denial, exact-session revoke, stale expected-session conflict, idempotent already-ended result.
- Media: cross-tour resolver/upload/delete denial; direct Storage read/write denial for every auth state.
- Notifications: ended-session user excluded even with stale membership/assignment/token; new valid login can register the current token.

Run `npm test`, `npm run test:emulators`, and `npm run build:web-admin` before release.
