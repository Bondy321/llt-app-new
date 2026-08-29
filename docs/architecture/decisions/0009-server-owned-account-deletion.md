# ADR 0009: Server-owned durable account deletion

Status: Accepted

Date: 2026-08-29

## Context

Account deletion used to be coordinated by the mobile client. It derived tour, booking, principal,
media and chat scope from cached handset state, performed several independent destructive calls and
finally deleted Firebase Auth. A rejected multi-path write, network timeout, app termination or stale
cache could therefore leave a partially deleted account with no durable recovery handle. The client
also needed account-deletion-specific write authority in Realtime Database rules.

The product promise is narrower than deleting every record connected to a traveller or driver. It
removes the app account and installation authority, notifications, local/offline data, active-tour
passenger app content where ownership is exact, and Firebase Auth. Bookings and identity sources,
legal/accounting/operational records, tour definitions, manifests, other users' content, canonical
driver records and assignments, and shared driver-principal content must survive.

## Decision

Account deletion is a private, server-owned, durable workflow. The mobile app is a protocol client:
it supplies only the exact current app-session ID and a cryptographically random opaque deletion
receipt. It does not supply a booking reference, tour, role, principal, driver, media owner or list of
records to delete.

The authenticated `requestAccountDeletion` Function validates the request and derives the complete
scope from the current `app_sessions/{authUid}` record and trusted server-owned identity records. It
then reserves the deletion atomically by writing a private durable job, queue entry and non-expiring
active barrier at the first destructive boundary. That same commit revokes the captured session and
notification installation authority. The reservation is idempotent for the receipt and rejects a
changed session or incomplete/contradictory authority.

The active barrier blocks passenger and driver session issuance for that UID. Passenger deletion also
installs a hashed booking/principal admission barrier, held behind a shared server lock, so another
anonymous UID cannot reclaim the booking while deletion is running. A permanent hashed deleted-UID
tombstone prevents a still-valid token for the deleted Auth user from recreating server state after
completion. Reservation revokes the captured app session and records the trusted private scope, so
later phases never depend on Firebase Auth still existing or on mutable client state. Work is processed
in bounded phases:

```text
reserved
  -> live_state_cleanup
  -> authority_release
  -> group_media
  -> private_media
  -> chat_scrub
  -> account_records
  -> auth_delete
  -> completed
```

Every page and substage is idempotent. Durable cursors advance only after their side effects succeed.
The queue claim and job lease both use opaque owners, expiry and monotonically increasing revisions;
a worker may commit only while its exact lease owner, revision and phase still match. Expired work can
be reclaimed after a crash. Consecutive transient failures use bounded backoff. An exhausted transient
job becomes retryable `requires_attention` without losing its cursor and can be requeued through the
authenticated retry endpoint. A malformed phase, substage, scope or trusted media path instead becomes
non-retryable `requires_attention` until the invariant is repaired through a reviewed code/data fix.

Notification deletion uses the internal device cleanup contract under its existing device lock and
creates/preserves the permanent notification tombstone in the reservation commit. Media deletion uses
trusted metadata and Storage paths; it never accepts a client path. A private per-record lock serialises
normal upload/delete mutations with account deletion. The durable deletion claim fingerprints the RTDB
record and captures each Storage generation; deletes use `ifGenerationMatch` and fail closed if a path,
record or object generation changes. Passenger group/private media and passenger-authored active-tour
chat are removed or scrubbed in bounded pages. Chat tombstones use a non-identifying account-deletion
marker and owned reactions are removed. Deterministic notification jobs derived from those passenger
messages are replaced with content-free privacy tombstones so delayed triggers cannot recreate copied
sender names, message text or navigation identifiers. Both initial fanout and individual retry
submissions hold and immediately re-fence the parent job lease before provider I/O, so privacy
replacement either waits for an in-flight submission or wins before stale content can be sent. Queued
notification activation repairs a missing exact queue pointer on trigger replay. Driver-principal
media, chat, reactions, canonical read state and assignment-owned pickups remain shared operational
content.

Firebase Auth deletion is the last destructive phase. A lease-fenced transaction first replaces the
working job with an internal completed record plus a temporary private `completionCleanup` marker.
That durable marker contains only the coordinates needed to finish exact cleanup. While it exists,
the public projection remains `pending` at `auth_delete`, and retention cleanup cannot remove the job.
Replayable reconciliation writes or validates the minimal permanent receipt-derived completion
tombstone before it compare-removes the exact barriers and warning. It then conditionally strips the
private marker, publishes the bounded PII-free completed projection and removes the exact queue entry.
A crash at any boundary is queue-replayable, and a stale worker cannot overwrite the completed job or
delete a successor barrier. The detailed record expires after its configured retention period, while
the identifier-free tombstone lets a reinstalled or freshly authenticated client confirm completion
without recovering the deleted UID.

The public status surface returns only status, phase, retryability, safe timestamps and bounded counts.
It never returns the deletion ID, receipt, UID, session, booking, passenger, driver, tour, message or
Storage identifiers. Internally recorded failure and terminal-warning details are bounded reason codes
or hashes rather than raw exception messages or customer data. Structured logging masks identifier
and path fields and redacts exception message/stack text; expired terminal warnings are removed by
bounded retention cleanup.

The mobile app persists the receipt and validated original Auth UID in its dedicated secure
account-deletion namespace before making the request. The UID is local-only cleanup scope: it is not
part of the public app-session projection and is never transmitted to the deletion endpoints. Once the
server accepts the reservation the app purges local account/session/offline state using that captured
UID, replaces Firebase Auth with a fresh anonymous installation, and polls status by receipt. Startup
and login remain blocked by the local pending record until completion; app termination and lost
responses therefore resume rather than restart deletion. The secure recovery record is excluded from
the initial local purge and is removed only after confirmed completion and final local cleanup.

`account_deletion_rollout/v1` controls removal of legacy client deletion permissions. A missing record
means `compatibility`. A valid compatibility record preserves the temporary legacy rule paths while
new clients use the server workflow. A malformed record fails closed. `server_only` is reserved for an
explicit later cutover and is not enabled by this change.

## Consequences

- Deletion can survive app termination, worker crashes, network timeouts and Auth removal.
- Scope and preservation decisions are made once from trusted server data and cannot be widened by a
  client request.
- Login, logout, driver policy and assignment workflows must respect the deletion barrier and existing
  UID/session/driver locks.
- Storage and Realtime Database are not one transaction, so idempotent phases, cursors and verification
  remain required.
- Normal feature permissions for logs, chat edits/reactions, notification read state, live tracking,
  photo captions and raw session-owned live state remain until separately redesigned; only legacy
  account-deletion permissions are candidates for the later `server_only` cutover.
- Operators respond through the status/retry protocol and warning records, not by editing jobs or
  reconstructing private scope manually.
- Once account-record cleanup completes, the job shreds booking, session, tour, principal, driver,
  media-owner and actor scope before attempting Auth deletion.
- Passenger identity authorization and app-session issuance share the UID and hashed-booking locks;
  both locks are renewed and re-fenced immediately before the atomic issuance write. Delayed photo
  variant triggers share the per-record media lock and compare the exact RTDB fingerprint, so they
  cannot recreate metadata after deletion.

The canonical schemas and ownership matrix are in
[`docs/data-contracts/account-deletion.md`](../../data-contracts/account-deletion.md). Operational
response is in [`docs/operations/account-deletion.md`](../../operations/account-deletion.md).

This decision and its implementation do not deploy Functions or rules, enable `server_only`, publish
an OTA, merge a branch or otherwise perform a production cutover.
