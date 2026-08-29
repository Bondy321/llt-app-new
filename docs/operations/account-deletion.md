# Account deletion operations runbook

## Scope and release state

This runbook covers the server-owned account-deletion workflow described in
[`docs/data-contracts/account-deletion.md`](../data-contracts/account-deletion.md). The repository
change prepares code and documentation only. It does not deploy Functions or rules, mutate production
data, enable `server_only`, publish mobile code, merge a branch or perform a cutover.

Never manually reconstruct deletion scope from a booking, email, passenger name, driver code or tour.
Never edit a job cursor/phase, delete the active barrier, delete Auth early, or run ad hoc broad RTDB or
Storage cleanup. The durable job and trusted scope are the authority.

## Operator-visible states

| Status | Meaning | Operator action |
|---|---|---|
| `accepted` | Reservation and login barrier are durable; processing may not have claimed the job yet. | Observe. A lost mobile response is safe. |
| `pending` | A phase is active, leased, backing off or awaiting the next queue claim. | Observe lease/backoff; intervene only if the documented thresholds are exceeded. |
| `requires_attention` | Either eight transient failures exhausted automatic retry (`retryable: true`) or a malformed trusted invariant failed immediately (`retryable: false`); scope and cursors remain durable. | Triage the sanitised terminal warning. Requeue only retryable work after fixing its external cause; use a reviewed code/data repair for non-retryable malformed state. |
| `completed` | All phases including Auth deletion completed; private scope was removed from the retained job. | Confirm safe completion projection and allow final device cleanup. |

Phases are `reserved`, `live_state_cleanup`, `authority_release`, `group_media`, `private_media`,
`chat_scrub`, `account_records`, `auth_delete`, and `completed`.

## Normal request and recovery

1. The signed-in app persists a high-entropy `delrec_v1_...` receipt and sends it with the exact active
   `expectedSessionId` to `requestAccountDeletion`.
2. A safe `accepted` response means the server job, queue entry, non-expiring UID login barrier,
   permanent hashed UID tombstone, any passenger hashed-booking barrier and captured session
   revocation are durable. It does not mean every deletion phase has completed.
3. The device purges scoped local data, creates a fresh anonymous Auth installation and polls
   `getAccountDeletionStatus` using only the receipt.
4. App termination, offline state, timeout, duplicate request or lost response must resume the same
   receipt. Do not create a second receipt when a pending record exists.
5. The device remains on the blocking status screen until the server reports `completed` and final
   local cleanup succeeds.

Public responses contain no customer identifiers. Operations must not ask a customer to send a receipt
through ordinary email/chat; it is a bearer capability and should remain only in the app's secure local
state.

## Request/status failure guide

| HTTP/reason | Meaning | Response |
|---|---|---|
| `400 INVALID_INPUT` | Request shape or receipt/session pattern is invalid. | Do not alter server state; update/repair the client and preserve a valid pending receipt. |
| `401 INVALID_CREDENTIALS` / `APP_CHECK_REQUIRED` | Auth or the shared App Check gate failed. | The status client performs one fresh-anonymous Auth retry; persistent failure is configuration/device attestation, not permission to bypass the gate. |
| `409 SESSION_CHANGED` | The requested session is no longer exact-current. | Do not delete from cached scope. Require a current secure session unless the receipt was already accepted. |
| `409 ACCOUNT_DELETION_IN_PROGRESS` | An active barrier, reservation or competing operation exists. | Resume the existing receipt/status; do not create or remove barriers manually. |
| `409 SESSION_IN_PROGRESS` / `DEVICE_UPDATE_IN_PROGRESS` | Existing session/device lock owns mutation. | Retry after the bounded lock expires or finishes. |
| `422 ACCOUNT_DELETION_SCOPE_INCOMPLETE` | Trusted session/profile/identity records contradict or lack required scope. | Investigate the authority data; do not infer scope from customer-supplied details. |
| `429 RATE_LIMITED` | Hashed receipt/Auth quota exceeded. | Honour retry/backoff; do not rotate receipts to evade it. |
| `503 ACCOUNT_DELETION_UNAVAILABLE` | Rollout record is malformed or the service failed closed. | Restore an exact reviewed compatibility record through the normal controlled process; do not enable `server_only`. |
| `404 ACCOUNT_DELETION_STATUS_UNAVAILABLE` | No job matches that receipt-derived ID. | Keep the local record and investigate request acceptance; never claim completion. |

## Triage sequence

For an alert or stalled deletion, inspect only the private server state using approved operations
access:

1. Confirm the job exists and note `status`, `phase`, safe attempt/failure code, backoff time and whether
   the queue entry exists. Do not copy `privateScope` into tickets or logs.
2. Check the UID active barrier and, for passenger work, the hashed-booking active barrier still point
   to the same deletion ID. Their presence during pending or `requires_attention` is expected and
   neither may be removed. The permanent hashed UID tombstone is also expected and must never be
   removed, including after completion.
3. If a lease is present, compare its expiry, phase and revision with the job. A non-expired lease means
   another worker owns progress; do not race it. An expired lease is recoverable by the queue worker.
4. Check that the queue entry is due or leased. Job state is authoritative if queue state is absent or
   stale. A retry first persists `retryRequestedAtMs`; the bounded scheduler repair pass recreates a
   missing due queue entry and compare-clears that marker. Use the supported retry path rather than
   creating a hand-written queue record.
5. Use the sanitised `terminalWarningId`/warning record and bounded reason code to identify the failing
   subsystem. Do not expose warning internals through the public status endpoint.
6. For `retryable: true`, correct the external dependency first, then call `retryAccountDeletion` with
   the same receipt from the authenticated recovery client. Retry must preserve the phase cursor and
   summary. For `retryable: false`, do not call retry or edit the job; repair the malformed invariant
   through the normal reviewed code/data process.

At `auth_delete`, only the Auth UID, principal type and any hashed passenger barrier coordinate remain
in private scope. Missing booking, tour, session, driver and actor fields are expected and must not be
reconstructed from operational data.

## Failure response by phase

### `reserved` or `live_state_cleanup`

- Confirm app-session, location and chat-presence locks are not held by a live operation.
- Exact-session raw leaves may already be absent; that is idempotent success.
- Preserve assignment-owned `driver_location_pickups`; only exact session-owned location/presence/typing
  leaves are eligible, followed by projection reconciliation.

### `authority_release`

- Passenger participant/grant/session authority is revoked in the atomic reservation. In this phase,
  confirm security/binding compare conditions still refer to the captured UID and principal. A
  replacement value must never be deleted.
- For drivers, `drivers/{driverId}/authUid` is removed only if it still equals the captured UID. Preserve
  the canonical driver record and assignment.
- Role-claim and driver-policy cleanup jobs are compare-deleted only for the captured session.

### `group_media` or `private_media`

- A missing Storage object or RTDB record is an idempotent success.
- Inspect the shared five-minute server-only media-record lock and durable `_serverDeletion` claim.
  The claim fingerprints the non-claim RTDB record and captures exact Storage generations.
- Delayed photo-variant generation uses that same record lock and may update metadata only when the
  exact source record fingerprint still matches. A late trigger must not recreate a missing record.
- Investigate permission, bucket/region and transient Storage failures without substituting a client
  path. A changed metadata path, record fingerprint or `ifGenerationMatch` precondition fails closed;
  never bypass it with an unconditional delete. The trusted RTDB metadata supplies all allowed
  source/viewer/thumbnail paths.
- Resume from the durable 20-record cursor. Never broad-delete a tour prefix or another principal's
  content.

### `chat_scrub`

- Resume from the durable 50-message cursor.
- Passenger messages retain a structural tombstone but no content/attachment/customer identifier;
  sender fields and `deletedBy` use fixed account-deletion sentinels.
- Replying messages remain, but copied sender-name/preview context pointing at a scrubbed passenger
  message is removed.
- Remove only reactions whose actor key belongs to the captured passenger scope. Preserve shared
  driver-principal and unrelated tour/user content.
- Confirm deterministic passenger chat/photo notification jobs contain only `privacy_deleted`
  tombstones with no sender, preview, navigation, source, tour or message fields. Exact job queues and
  child delivery state are removed; the tombstone blocks a delayed trigger from restoring the copy.
  A live parent-job lease means initial fanout or an individual retry may be at the provider boundary;
  deletion must retry after that lease exits. Never remove the lease manually. A privacy tombstone
  that wins before the provider boundary prevents both initial and retry submissions from sending.

### `account_records`

- Notification device and consent removal must run through the internal device-lock helper and leave a
  permanent tombstone. Do not remove a tombstone to make retry appear successful.
- Preserve bookings, booking identities/meta, tours, manifests, legal/accounting/safety/reporting data,
  driver profiles/assignments and shared driver content.
- Missing exact UID-owned records are idempotent success.

### `auth_delete`

- Auth is deliberately last. `user-not-found` is success.
- A transient Auth Admin error remains retryable; do not mark completion manually.
- After Auth succeeds, a lease-fenced transaction first stores an internal completed job with a
  temporary private `completionCleanup` marker. Its public projection remains `pending` at
  `auth_delete`. Reconciliation writes or validates the minimal receipt-derived completion tombstone
  before it compare-removes the exact active/passenger barriers and warning, then strips the marker
  and removes the queue. A crash leaves the internal completion marker and queue replayable; never
  remove the barriers or mark the job publicly completed by hand.

## Login barrier and customer response

`account_deletion_active/v1/{authUid}` and the passenger hashed-booking active barrier have no expiry.
Passenger and driver login must return the safe `ACCOUNT_DELETION_IN_PROGRESS` reason while the
relevant barrier exists. The permanent hashed UID tombstone also rejects a stale token for the deleted
Auth user after completion. Tell the customer that deletion is still being processed and to reopen the
app online; do not invite a new login, create a replacement booking binding, remove either active
barrier, or remove the permanent UID tombstone.

If the app shows retryable `requires_attention`, ask the customer to keep the app installed and online
while operations resolves the backend condition. After remediation, the supported manual Retry action
calls the same receipt-scoped endpoint. For non-retryable attention state, the app remains blocking and
the client cannot requeue malformed work; escalate through the reviewed repair path. Do not state that
deletion completed until status is `completed`.

## Rollout checks

The only safe pre-cutover states are:

- no `account_deletion_rollout/v1` record, which means `compatibility`; or
- an exact schema-version-1 record with phase `compatibility`, positive revision and timestamp.

A malformed or partial record must fail closed. `server_only` is a future explicit cutover that removes
legacy direct account-deletion permissions. This change does not enable it. Do not set or test that
value in production as part of ordinary incident response.

Before any separately approved release, verify in non-production:

- exact-session reservation and duplicate/lost-response idempotency;
- passenger and driver login barrier behavior;
- fresh-UID passenger reauthorization is blocked by the hashed-booking barrier and stale deleted-UID
  tokens remain blocked by the permanent hash-only tombstone;
- retry-marker repair reconstructs a missing queue entry without replacing a live lease;
- worker crash/lease expiry recovery at every phase and cursor;
- media/chat pagination and ownership isolation;
- notification tombstone monotonicity;
- Auth-last ordering and `user-not-found` idempotency;
- fresh-anonymous receipt status after original Auth deletion;
- completion redaction and 180-day retention cleanup;
- post-retention status recovery through the identifier-free completion tombstone;
- passenger-authored notification-job redaction and delayed-trigger tombstone behavior;
- compatibility rules for old clients, with malformed rollout fail-closed.

The later production cutover, if approved, must follow the repository release gates and an explicit
Functions/rules/mobile compatibility plan. This runbook intentionally contains no instruction to deploy,
merge, mutate the rollout record or enable `server_only`.
