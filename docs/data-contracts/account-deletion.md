# Account deletion data contract

## Purpose and authority

Account deletion is a durable server workflow, distinct from normal logout. The server is the only
authority for scope, ordering, progress and completion. Mobile sends an opaque receipt and the exact
current session ID only; booking, tour, passenger, driver, content ownership and Storage paths are
always derived from trusted server records.

The public promise is to remove the app account/installation, current app authority, notification
device state, local/offline data, active-tour passenger content owned by that principal, and Firebase
Auth. It does not erase booking, legal, accounting, safety, reporting or operational records.

## Public protocol

All three endpoints are authenticated HTTPS `POST` Functions in `europe-west1`, with CORS disabled.
They accept exact-key JSON objects and reject unknown properties. They reuse the existing
group-media/session App Check gate controlled by `REQUIRE_APP_CHECK_FOR_GROUP_MEDIA` (and the shared
login requirement); the absence of an App Check token never expands authority.

### Request deletion

`requestAccountDeletion` accepts:

```json
{
  "expectedSessionId": "sess_v1_0123456789abcdef0123456789abcdef",
  "deletionReceipt": "delrec_v1_<64 lowercase hexadecimal characters>",
  "clientVersion": "optional bounded version"
}
```

The receipt is 32 bytes of cryptographically secure random data generated and durably saved before
network I/O. The server derives `deletionId = acctdel_v1_<sha256(receipt with domain separator)>`; the
receipt itself is never stored in RTDB or logs.

The Function requires the authenticated UID to own the exact active, non-expired session. It derives:

- Passenger: opaque principal, tour, booking reference, stable identity/key and private-photo owner
  from the session, profile, security record and exact identity binding.
- Driver: canonical `driver:{driverId}` principal, driver record and optional current tour from the
  session/profile/driver records.

Any missing, stale, ambiguous or contradictory authority fails before reservation. A different current
session returns `SESSION_CHANGED`. An active deletion returns the existing operation only when it is
the same receipt-derived deletion; it cannot be replaced by a second receipt.

An accepted response is a safe status projection:

```json
{
  "success": true,
  "status": "accepted",
  "phase": "reserved",
  "retryable": true,
  "createdAtMs": 123,
  "updatedAtMs": 123
}
```

### Read status and retry

`getAccountDeletionStatus` and `retryAccountDeletion` accept exactly:

```json
{ "deletionReceipt": "delrec_v1_<64 lowercase hexadecimal characters>" }
```

Status lookup is receipt-capability based after initial acceptance, so it works with a fresh anonymous
Firebase Auth installation. It returns only:

- `success: true`;
- `status`: `accepted`, `pending`, `requires_attention`, or `completed`;
- one safe phase from the ordered phase list below;
- `retryable`;
- optional safe `createdAtMs`, `updatedAtMs`, and `completedAtMs` timestamps;
- optional bounded summary counts: `recordsRemoved`, `storageObjectsRemoved`,
  `chatMessagesScrubbed`, and `reactionsRemoved`.

The public response never contains the deletion ID/receipt, UID, session ID, booking reference, email,
phone, driver, tour, principal, message ID, Storage path, cursor, lease, failure or warning ID.

Distributed rate limits use one-way hashes of the deletion ID and authenticated UID. Initial requests
are limited to 12 per minute for both dimensions; status/retry calls are limited to 60 per minute for
the receipt dimension and 120 per minute for the Auth dimension. Raw receipt/UID values are not used as
limiter keys.

`retryAccountDeletion` is meaningful for retryable `requires_attention` or due pending work. It
preserves scope, cursors and successful substages; it never creates a new deletion or repeats a
completed side effect as a different operation. Terminal malformed scope/phase/substage/path failures
return `retryable: false` and cannot be requeued by the client.

## Private roots and schemas

All account-deletion roots are server-private in Realtime Database rules.

### `account_deletion_active/v1/{authUid}`

The non-expiring login barrier is created in the reservation transaction and removed only at durable
completion:

```json
{
  "schemaVersion": 1,
  "deletionId": "acctdel_v1_<64 lowercase hexadecimal characters>",
  "status": "pending or requires_attention",
  "createdAtMs": 123,
  "updatedAtMs": 456
}
```

Passenger and driver session issuance must call the shared barrier guard before and inside their
serialized issuance boundary. Presence of any active record fails with
`ACCOUNT_DELETION_IN_PROGRESS`; malformed records also fail closed. There is no TTL-based bypass.
Completion compare-deletes only a barrier that still names the same deletion operation.

### `account_deletion_passenger_active/v1/{bookingHash}`

Passenger reservation also creates a non-expiring admission barrier keyed by a domain-separated
SHA-256 hash of the trusted booking reference:

```json
{
  "schemaVersion": 1,
  "deletionId": "acctdel_v1_<64 lowercase hexadecimal characters>",
  "status": "pending or requires_attention",
  "createdAtMs": 123,
  "updatedAtMs": 456
}
```

Passenger identity authorization and session issuance check this barrier while holding the shared
hashed-booking lock. Presence of any value, including malformed data, fails closed with
`ACCOUNT_DELETION_IN_PROGRESS`. The barrier prevents a different anonymous UID from reclaiming the
same passenger identity while deletion is active. It is removed only by the exact completion update.

### `account_deletion_uid_tombstones/v1/{uidHash}`

Reservation permanently records a domain-separated SHA-256 hash of the deleting Auth UID:

```json
{
  "schemaVersion": 1,
  "permanent": true,
  "createdAtMs": 123
}
```

This private minimal tombstone survives completion. It prevents a cryptographically valid stale token
for the deleted Auth user from issuing a session after the UID-keyed active barrier is removed. It
contains no raw UID, receipt, deletion ID, booking reference, principal, tour or driver identifier and
is never returned through the public API.

### `account_deletion_completion_tombstones/v1/{deletionId}`

Exact finalisation also writes a permanent private completion marker. Its key is the same one-way
256-bit receipt-derived deletion capability ID used for job lookup. Its value contains only schema
version, `completed` status/phase, `retryable: false`, and completion/update timestamps. It contains no
UID, booking, passenger, driver, tour, path, summary or receipt. After the richer 180-day completion
record expires, status and retry endpoints use this marker so a long-offline handset is not stranded.

### `account_deletion_jobs/v1/{deletionId}`

An in-progress job is schema version 1 and contains:

- identity/lifecycle: `deletionId`, `status`, `phase`, `substage`, `createdAtMs`, `updatedAtMs`,
  `destructiveStartedAtMs`, `expiresAtMs`, and `availableAtMs`;
- `privateScope`: `authUid`, `expectedSessionId`, `principalType`, `principalId`, `tourId`, plus exact
  passenger `bookingRef`, stable identity/key/private owner fields or exact driver `driverId`, and the
  server-derived `actorKeys` allowlist used for owned content/reaction comparisons;
- durable phase state: `cursors.groupMediaAfterPhotoId`, `privateMediaAfterPhotoId`, and
  `chatAfterMessageId`, plus the current phase-specific `substage`;
- bounded `summary` counters;
- retry state: `attemptCount`, `consecutiveFailureCount`, `firstAttemptAtMs`, `lastAttemptAtMs`,
  `lastFailureReason`, `availableAtMs`, and an optional `retryRequestedAtMs` durable requeue marker;
- top-level monotonic `leaseRevision` and authoritative `lease` containing `ownerId`,
  `acquiredAtMs`, `expiresAtMs`, and the phase captured when leased;
- optional `terminalWarningId`, which refers only to a sanitised operations warning.

The ordered phases are:

1. `reserved`
2. `live_state_cleanup`
3. `authority_release`
4. `group_media`
5. `private_media`
6. `chat_scrub`
7. `account_records`
8. `auth_delete`
9. `completed`

The worker may commit a cursor, substage, summary, failure or phase transition only when the job still
contains its exact lease owner, lease revision and leased phase. Page sizes are bounded to 20 media
records and 50 chat records. A successful page records its next cursor in the same lease-checked job
transaction after the page's idempotent mutations succeed. Missing already-deleted records/objects are
success, not fatal corruption.

Job and queue leases last five minutes. Each job claim increments `attemptCount`; transient failures
increase `consecutiveFailureCount` and back off from 30 seconds exponentially to a 30-minute cap. A
successful leased transition clears the consecutive failure reason/count. `expiresAtMs` is bounded
workflow/alert metadata, not permission to remove an unfinished job or bypass the barrier.

After eight consecutive transient failures the job becomes `requires_attention` with
`retryable: true`, retains its exact scope, substage and cursors, removes/relinquishes the current
lease, and publishes a sanitised terminal warning. A malformed phase, substage, scope or trusted media
path enters `requires_attention` immediately with `retryable: false`; the public retry endpoint will
not requeue it. Backoff and retries do not weaken the permanent active login barrier.

After Auth deletion succeeds, a lease-fenced transaction replaces the working job with an internal
completed record plus a temporary private `completionCleanup` marker. The marker retains only the
already shredded Auth UID, optional hashed passenger barrier key, completion revision and optional
sanitised warning ID. Public status remains `pending` at `auth_delete` while the marker exists.
Replayable reconciliation first writes or validates the permanent completion tombstone, then removes
only barriers/warnings still owned by the same deletion. Finally, an exact completion-revision
transaction strips the marker and exposes this authoritative public completed record:

```json
{
  "schemaVersion": 1,
  "deletionId": "acctdel_v1_<64 lowercase hexadecimal characters>",
  "status": "completed",
  "phase": "completed",
  "createdAtMs": 123,
  "updatedAtMs": 456,
  "completedAtMs": 456,
  "retainUntilMs": 15552000456,
  "summary": {
    "recordsRemoved": 0,
    "storageObjectsRemoved": 0,
    "chatMessagesScrubbed": 0,
    "reactionsRemoved": 0
  }
}
```

The marker-removal transaction is conditional on the exact cleanup revision and completion time, so a
stale finalizer cannot overwrite a successor. Completion removes `privateScope`, session/UID/
principal/tour/booking/driver fields, cursors, failures, warning IDs, substages, cleanup data and lease
data. The queue is compare-removed only after reconciliation. Completion records are retained for 180
days, then removed by bounded server cleanup; any completed job that still carries
`completionCleanup` is excluded. Missing `retainUntilMs` values are also excluded from that cleanup
query, so active jobs cannot starve due completed records. The minimal private completion tombstone
remains afterward.

### `account_deletion_queue/v1/{deletionId}`

```json
{
  "schemaVersion": 1,
  "deletionId": "acctdel_v1_<64 lowercase hexadecimal characters>",
  "dueAtMs": 123,
  "lease": {
    "ownerId": "opaque worker owner",
    "acquiredAtMs": 123,
    "expiresAtMs": 456
  }
}
```

The queue claim is an exact RTDB transaction. A worker may claim only due, absent/expired-lease work.
Removing or rescheduling the queue entry is compare-safe on the same owner. Queue absence never means
the job completed; the job is authoritative.

`processAccountDeletionJobs` runs every five minutes in `europe-west1` with one scheduler instance. It
claims at most 10 due jobs per run, while the leases still provide crash/replay correctness independent
of scheduler concurrency. Before claiming work, the scheduler performs a bounded repair pass for jobs
with `retryRequestedAtMs`, reconstructing a missing due queue entry without overwriting an unexpired
queue lease and then compare-clearing the marker. This closes a crash between retry authorization and
queue publication. The same bounded run removes at most 50 expired completion records.

### `account_deletion_locks/v1/{deletionId}`

The request-only reservation lock prevents two simultaneous requests for the same receipt-derived ID:

```json
{
  "schemaVersion": 1,
  "owner": "opaque request owner",
  "createdAtMs": 123,
  "expiresAtMs": 180123
}
```

It has a three-minute lease, is recoverable only after expiry, and can be released only by its exact
owner. It serializes reservation; it is not the durable deletion authority and cannot replace the
active barrier, job lease or per-UID app-session lock.

### `account_deletion_passenger_locks/v1/{bookingHash}`

This three-minute exact-owner lease serialises passenger identity authorization/session issuance with
account-deletion reservation for the same trusted booking. Both workflows renew the lock and recheck
the passenger barrier immediately before their atomic authority write. The lock is only a concurrency
boundary; the non-expiring passenger barrier remains the durable authority after reservation.

### `media_record_locks/v1/{visibility}/{tourId}/{ownerOrGroup}/{photoId}`

This server-private five-minute lock serialises normal media upload/delete mutations with deletion of
the same group or private photo record. Account deletion records a durable `_serverDeletion` claim on
the trusted RTDB metadata containing a fingerprint of the non-claim record and the exact Storage
generation (or `missing`) for each source/viewer/thumbnail path. Retries reuse that claim. Storage
deletes require `ifGenerationMatch`; changed paths, metadata or object generations fail closed instead
of deleting a successor object.

### `account_deletion_rollout/v1`

```json
{
  "schemaVersion": 1,
  "phase": "compatibility",
  "revision": 1,
  "updatedAtMs": 123
}
```

- Missing record: `compatibility`.
- Exact valid `compatibility`: new workflow enabled while temporary legacy account-deletion rules
  remain available to older clients.
- Malformed, unknown schema, unknown phase or partial record: fail closed.
- Exact valid `server_only`: reserved for a separately reviewed cutover that denies the legacy direct
  deletion permissions. It is not enabled or implied by this implementation.

The later `server_only` rules deny only the old client-orchestrated whole-user/log deletion and exact
account-deletion deletes for passenger identity/security and driver `authUid`. They continue to allow
the independently authorised normal-feature leaf writes for logs, profile preferences/device state,
chat/reactions, read state, live state and captions. Database and Storage paths already owned solely by
Admin Functions remain private in both phases.

## Atomic reservation and ordering

Reservation is the first destructive boundary and occurs before media, chat, profile or Auth deletion.
Under the per-UID app-session lock and relevant notification/driver coordination boundaries, the
server:

1. validates rollout and request shape;
2. confirms exact current session and derives trusted scope;
3. confirms no conflicting UID or passenger deletion and no permanent deleted-UID tombstone;
4. atomically creates the job, queue entry, UID active barrier, permanent hashed UID tombstone and,
   for a passenger, the hashed-booking active barrier; revokes captured session authority; removes
   notification installation/consent state and creates/preserves its permanent device tombstone;
5. returns the safe `accepted` projection.

A failed reservation changes no destructive data. Once reservation succeeds, login cannot issue a new
session for the UID, even if the client loses the response. Later phases use only the captured trusted
scope and their durable cursors.

After `account_records` finishes, the job shreds its no-longer-needed booking, session, tour,
principal, driver, stable-identity, media-owner and actor fields. `auth_delete` retains only the Auth
UID required for the Admin delete, principal type and the already-hashed passenger barrier coordinate
required for exact finalisation.

## Deletion and preservation matrix

| Trusted path/state | Ownership | Passenger action | Driver action |
|---|---|---|---|
| `app_sessions/{uid}` | Exact UID/session authority | Revoke captured session in reservation | Same |
| `account_deletion_active/v1/{uid}` and hashed passenger active barrier | Temporary deletion admission authority | Create in reservation; remove only at exact completion | Create UID barrier; remove only at exact completion |
| `account_deletion_uid_tombstones/v1/{uidHash}` | Permanent stale-token fence | Create in reservation and preserve | Same |
| `tours/{tour}/participants/{uid}` | Passenger session membership | Delete only captured passenger membership | Not applicable |
| `tour_access_grants/{tour}/{uid}`, `booking_access_grants/{booking}/{uid}` | Server-issued UID authority | Delete exact server-derived grants | Delete only any exact captured UID/tour grant created by session cleanup |
| `users/{uid}`, `logs/{uid}` | UID account/diagnostics | Delete | Delete |
| `tours/{tour}/liveTracking/{uid}` and UID notification read/migration state | UID live/inbox state | Delete exact UID leaves | Delete exact UID leaves; preserve canonical driver-principal read history |
| Passenger-principal notification read state | Passenger principal | Delete exact captured active-tour branch | Not applicable |
| `identity_bindings/{stableKey}/{uid}` | Passenger principal/UID binding | Compare-delete exact `true` binding | Not applicable |
| `identity_bindings_meta/{stableKey}` | Booking identity metadata | Preserve | Not applicable |
| `passenger_identity_security/{booking}` | Booking security record | Compare-delete only exact `authorizedAuthUid`; preserve the record and principal metadata | Not applicable |
| `notification_devices/{uid}`, `notification_consents/{uid}` | UID installation/consent | Delete under device lock | Same |
| `notification_device_tombstones/{uid}` | Existing UID-keyed anti-recreation fence | Create/preserve without a duplicate UID value and with monotonic revision | Same |
| `driver_location_sessions`, `chat_presence_sessions`, `chat_typing_sessions` | Exact app-session raw live state | Delete exact captured session; reconcile projections | Same |
| `driver_location_pickups` | Assignment/tour operational state | Preserve | Preserve |
| Public driver-location/chat-status projections | Shared principal/tour projection | Reconcile only | Reconcile only |
| `drivers/{driverId}/authUid` | Shared driver authority scalar | Not applicable | Compare-delete only if it still equals captured UID |
| `drivers/{driverId}`, assignment, tours and manifests | Canonical operations data | Preserve | Preserve |
| `app_session_role_claim_jobs/v1/{uid}` and `driver_login_policy_cleanup/v1/{uid}` | Exact-session continuation work | Compare-delete only a job matching captured session | Same |
| Active-tour group/private photo metadata and trusted Storage variants | Principal-owned app content | Delete only trusted passenger-principal ownership | Preserve driver content, including canonical/shared records |
| `chats/{tour}/messages` | Tour content plus actor leaves | Scrub trusted passenger-authored messages and remove owned reactions/reply copies | Preserve messages/canonical driver reactions; remove only exact UID reaction leaves |
| Deterministic `notification_jobs/{jobHash}` for passenger-authored chat/photo messages | Copied sender, preview and navigation content | Replace with a content-free 30-day privacy tombstone and remove exact job child/queue state; tombstone blocks delayed trigger recreation | Preserve driver/shared operational notification jobs |
| `internal_chats` | Shared driver-principal content | No scope | Preserve canonical/shared content |
| `app_session_events` and sanitised terminal warning | Bounded operational audit | Preserve under normal retention; no raw customer/tour/driver identifiers | Same |
| Bookings, booking identity sources, reports, safety, legal/accounting records | Legal/operational source | Preserve | Preserve |
| Other users, tours, messages, reactions and media | Unrelated/shared data | Preserve | Preserve |
| Firebase Auth | UID identity | Delete last | Delete last |

Notification cleanup must use the internal helper that removes `notification_devices/{uid}` and
`notification_consents/{uid}` and creates/preserves `notification_device_tombstones/{uid}` with a
monotonic registration revision. Later registration cannot recreate a tombstoned UID.

Passenger-authored notification privacy replacement refuses to proceed while the parent notification
job has a live lease. Initial fanout and individual retry submission both acquire and immediately
renew that parent lease before calling the provider. If the content-free `privacy_deleted` tombstone
wins first, neither path may send or refresh it back into an ordinary job. The separate
`preparing`-to-`queued` activation is replay-safe: a repeated source trigger reconstructs the exact
missing fanout queue pointer from the already persisted queue key and version.

Storage deletion always uses paths read from trusted photo metadata and deletes all known source,
viewer and thumbnail variants before metadata completion. Each deletion holds the shared server-only
record lock, durably fingerprints the RTDB record, captures exact Storage generations and deletes with
generation preconditions. A concurrently changed path, record or object fails closed. Direct client
Storage access remains denied. Delayed photo-variant triggers acquire that same record lock and
compare the exact source metadata fingerprint before publishing a success or failure update, so a
late trigger cannot recreate deleted metadata or attach variants to a successor record.

Chat scrubbing preserves chronology while replacing passenger sender ID/stable ID/name with fixed
non-identifying sentinels and allowlisting only structural timestamp/status fields. It removes text,
captions, media/Storage fields, idempotency attribution and reply context. When another message quotes
a deleted passenger message, its copied sender name and preview context are removed without deleting
the replying user's own message. `deletedBy` is `account_deleted`, never a UID. Reactions are removed
only where the trusted actor key belongs to the captured passenger scope.

Firebase Auth deletion is attempted only after every prior phase is durable. `user-not-found` is
idempotent success. Completion is not published until Auth deletion is confirmed or already absent.

## Mobile recovery contract

Mobile stores a versioned pending record in the dedicated `LLT_ACCOUNT_DELETION` secure persistence
namespace. Schema v3 includes the receipt, the original Firebase Auth UID used only to select local
cleanup state, and—before acceptance—the expected session ID. The original UID is captured from the
current authenticated user and durably persisted before the first request. It is never sent to an
account-deletion Function, logged, displayed, or copied into app-session persistence. After acceptance
the record removes the session ID and retains the receipt and original local-cleanup UID; safe
`state`/phase, timestamps and counts; bounded request/status attempts and last safe reason; and the
`localCleanupState`, `localCleanupComplete`, and `completionHandled` markers. Cleanup states are
`not_started`, `commit_prepared`, and `complete`; local deletion states are `requesting`, `accepted`, `pending`,
`waiting_for_connection`, `requires_attention`, and `completed`.

After acceptance, initial local cleanup removes offline queues/assets, driver caches, notification feed
and registration state, photo viewer cache, safety queues, trusted contacts and logs for the validated
captured local scope. It does not remove another principal's shared-device state or the receipt. Only
after every scoped purge succeeds does the app durably set `commit_prepared`; it then removes ordinary
session, booking, tour and identity keys and durably sets `complete`. A restart from `commit_prepared`
repeats only the ordinary-key removal and complete-marker write, even if those keys are already absent.
The marker contains no passenger, driver, booking or tour scope and is never sent to Functions or logged.
The app then signs out/deletes local Auth persistence and creates a fresh anonymous Firebase Auth user
for status calls.

Startup detects the pending receipt before restoring tour/login UI and routes to the blocking deletion
status screen. It polls with bounded backoff, retries on foreground/connectivity recovery, and exposes
a manual retry only for retryable `requires_attention`. Non-retryable attention state remains blocking
and directs the user to support. Normal login remains unavailable while the receipt is pending.
After confirmed `completed`, the lifecycle first ensures scoped local cleanup has succeeded, persists
`completionHandled`, and only then clears the complete secure recovery record—including the original
UID and receipt—and allows normal login to resume.

## Logging, warnings and retention

- Never log receipt, deletion ID, raw UID/session, booking/email/phone/name, passenger/driver/tour IDs,
  Storage paths, message IDs or raw exception strings.
- Safe logs use operation-independent reason codes, bounded counts and one-way fingerprints where
  correlation is required.
- `requires_attention` publishes one deduplicated, sanitised operations warning referenced by
  `terminalWarningId`; identifiers are one-way hashes, the public status never returns that ID or
  warning body. It remains while the recovery job needs operator attention and is compare-removed by
  exact successful completion; stale unadopted warnings are ownership-safely removed. A bounded
  `retainUntilMs` sweeper removes expired superseded/hash-only warnings.
- In-progress jobs and active barriers have no expiry shortcut. Completed private-scope-free records
  retain only the bounded public-safe summary for 180 days.
- Permanent UID tombstones retain only a domain-separated one-way UID hash and the minimal version,
  permanence and creation fields required to reject stale deleted-user tokens.
- Structured safe logging treats receipt, deletion, UID/admin UID, session, principal/principal key,
  passenger, driver, tour, event, job, run, source, warning, attempt, installation,
  message, photo and Storage-path keys as sensitive and masks them.

See [ADR 0009](../architecture/decisions/0009-server-owned-account-deletion.md) and the
[operations runbook](../operations/account-deletion.md). This contract does not authorize deployment,
rollout mutation, `server_only` cutover, merge or production cleanup.
