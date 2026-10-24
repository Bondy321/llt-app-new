# Notification delivery contract

This matrix is authoritative for user-facing wording, producer payloads and delivery policy. All
production classes begin as deterministic server-owned jobs. `ticket_accepted` means Expo accepted a
message; `provider_accepted` means a later Expo receipt was successful. Neither status proves the
operating system displayed the notification.

Retention operations and rollback are specified in `docs/operations/notification-retention.md`.

`submission_unknown` is a terminal ambiguity: the server started a request but cannot prove whether
Expo accepted it. It is not a rejection, a partial delivery claim, or safe evidence that retrying
cannot duplicate a notification. Source projections report this separately as
`submissionUnknownCount` (or `notificationSubmissionUnknownCount` on safety/operational records),
while rejected counts include only known ticket or receipt rejections. `completedAtMs` records the
job's first terminal transition and source `deliveryCompletedAtMs` mirrors that stable timestamp;
later receipt/status synchronisation must not move either timestamp.

`ticket_rejected` is also terminal when every eligible attempt was definitely rejected before an
Expo ticket was accepted. It remains distinct from `provider_rejected`, which requires a later
provider-receipt rejection. Both statuses preserve the first completion timestamp and permit the
bounded manual requeue workflow; automatic retry remains limited to classified temporary failures.

Expo request errors are classified from the `expo-server-sdk` v4 error shape. HTTP 429/5xx and
definite pre-connect failures enter bounded durable retry; invalid 4xx/configuration/payload errors
are permanent; timeouts, connection resets and otherwise ambiguous post-write failures become
`submission_unknown` and are never automatically resent.

The fan-out queue claim and job lease share one owner and one absolute expiry. The queue pointer is
retained until page completion, so a killed worker is rediscoverable. A worker blocked by a live
foreign job lease retains the queue for that lease boundary; only missing, terminal, superseded,
expired or stale-version work removes the pointer.

Failure recovery compares the exact live job lease and page before changing job state or queue
revision. It then publishes the replacement queue leaf before retiring the old exact-owned pointer.
If publication crashes, discovery through the retained old pointer repairs the canonical queued
pointer before retiring the stale entry. This handoff cannot rewrite a successor's job or lease.

Audience accounting uses `eligible + skipped = audience`: audience is the unique UID/installations
considered, eligible means a durable delivery attempt represents the candidate, and duplicate-token
losers are skipped only. Each cursor page has a deterministic ID and commits counts plus cursor in
one owner-checked job transaction. Preview uses the same UID/token partition.

Tour announcements have one activation owner. The broadcast trigger persists both the durable tour
notice and its explicitly broadcast-owned chat message before it enqueues the deterministic job.
The chat trigger validates that message but does not enqueue or publish status for it; genuine chat
messages retain the ordinary chat-owned path.

| Class | Source and deterministic source ID | Audience and active session | Preference / sender | Lock-screen policy | Channel / priority | Expiry, collapse and grouping | Tap route and fallback | Job ID, retry and final state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Tour announcement | `broadcasts/{tourId}/{broadcastId}` / `tour_announcement:{tourId}:{broadcastId}` | Current tour passengers and assigned drivers; active app session required | `ops.driver_updates`; sender excluded | Admin title and bounded announcement preview; no booking/customer data | `llt_tour_updates_v2`, default | Admin expiry or 24h; no collapse; tag/thread by tour | `Chat` with `tourId`, deterministic announcement `messageId`, `noticeId`; durable tour notice | `notif_v2(sha256(source))`; temporary request/receipt retry; provider outcomes or `partial`, `no_recipients`, `expired` |
| Passenger group chat | `chats/{tourId}/messages/{messageId}` / `group_chat:{tourId}:{messageId}` | Current tour passengers and assigned drivers; active app session required | `ops.group_chat`; sender and duplicate token excluded | Sender name plus bounded text; no credentials | `llt_group_chat_v2`, default | 6h; distinct messages never collapse; tag/thread by tour | `Chat` with exact `tourId`, `messageId`, optional `noticeId`; in-app chat is fallback | Deterministic source hash; temporary retry; provider outcomes/partial/no recipients/expired |
| Group photo | Secure schema-v2 image chat message / `group_photo:{tourId}:{messageId}:{photoId}` | Current tour passengers and assigned drivers; active app session required | `ops.group_photos`; sender and duplicate token excluded | “Shared a photo”; never contains or persists a media URL | `llt_group_photos_v2`, default | 6h; distinct photos never collapse; tag/thread by tour | `Chat` with exact message and `photoId`; chat/photo metadata fallback | Deterministic source hash; one upload/message creates at most one job; normal retry/final states |
| Internal driver chat | `internal_chats/{tourId}/messages/{messageId}` / `internal_driver_chat:{tourId}:{messageId}` | Other coherently assigned drivers; active app session required | `ops.driver_updates`; sender excluded | Driver sender plus bounded text | `llt_driver_operations_v2`, high | 4h; distinct messages; tag/thread by tour | `Chat` with `internalDriverChat=true`, exact tour/message; internal chat fallback | Deterministic source hash; normal retry/final states |
| Itinerary change | Semantic write to `tours/{tourId}/itinerary` / `itinerary:{tourId}:{semanticRevision}` | Current tour passengers and assigned drivers; active app session required | `ops.itinerary_changes`; no sender | Bounded summary only | `llt_tour_updates_v2`, default | 24h; latest semantic revision replaces older tour revision; tag/thread by tour | `Itinerary` with `tourId`, `noticeId`; durable tour notice | Deterministic revision job; superseded state is never sent; normal retry/final states |
| Driver Tour Pack change | Semantic published pack revision / `driver_tour_pack:{departureKey}:{revision}` | Coherently assigned driver installations; active app session required | `ops.driver_updates`; no sender | Bounded changed-section/acknowledgement summary; no passenger or contract/service content | `llt_driver_operations_v2`, high | 12h; latest departure revision replaces older; tag/thread by departure | `DriverTourPack` with `tourId`, `departureKey`, `revision`, bounded `changedSections`; pack remains fallback | Deterministic revision job; supersession plus normal retry/final states |
| Safety report | `tours/{tourId}/safetyAlerts/{eventId}` / `safety:{tourId}:{eventId}` | Currently assigned drivers require an active matching app session; authorised operations admins are an always-on escalation audience and do not require tour membership | Mandatory safety policy; bypasses optional routine preferences; reporter excluded | Category/severity only; never free-text incident content | `llt_safety_v2`, high | 2h; distinct incidents never collapse; event tag/thread | `SafetyAlertDetail` with exact `tourId`, `eventId`; authorised dashboard/detail fallback | Deterministic incident job; warning on no recipient/no ticket/provider reject/unresolved receipt |
| Critical safety or SOS | Same safety source / `critical_safety:{tourId}:{eventId}` | Currently assigned drivers require an active matching app session; authorised operations admins remain an always-on escalation audience | Mandatory safety policy; reporter excluded | Urgent generic copy only; never free text; no iOS critical-alert entitlement | `llt_safety_v2`, high | 30m; never collapse distinct incidents; event tag/thread | Exact `SafetyAlertDetail`; dashboard warning/acknowledgement fallback | Deterministic incident job; aggressive bounded retry and visible escalation on failure |
| Future-tour category broadcast | `category_broadcasts/{categoryKey}/{broadcastId}` / `future_tour:{categoryKey}:{broadcastId}` | Current notification installations explicitly opted into category; no active tour session required | `marketing.{categoryKey}` default false; sender not applicable | Bounded title and preview; full body stays in durable detail | `llt_future_tours_v2`, default | Admin expiry or 7d; broadcast tag/thread by category | `MarketingNotificationDetail` with `categoryKey`, `broadcastId`; server-owned detail record | Deterministic source hash; paged full audience; normal retry/final states |
| Local test notification | Explicit mobile “Local display test” action / local generated ID | Current device only; no server audience | No preference mutation | Fixed test copy | `default` for compatibility | Immediate/local only | Existing preferences screen | No server job, ticket or provider claim |
| Full server test notification | Admin authenticated current-device command / `server_test:{adminUid}:{requestId}` | Only authenticated operations admin’s registered current installation | Explicit test action; no preference bypass beyond target device | Fixed diagnostic copy without token data | `llt_driver_operations_v2`, high | 1h; no collapse | `NotificationPreferences` or admin test result | Dedicated deterministic job through normal ticket/receipt pipeline; final provider result shown |

## Job and attempt invariants

- Jobs are server-owned schema version 1 records and contain bounded presentation/navigation data,
  never raw Expo tokens, credentials, names used as identity, or incident free text.
- One source event maps to one deterministic job ID. Repeated Function delivery is idempotent.
- Operational delivery uses the shared current-session validator at each candidate evaluation, including retry. Retained participant/device rows cannot authorize a transferred, cancelled or withdrawn booking, revoked staff approval, a changing driver policy, an assignment transition (including a false-valued marker), or a stale single-phone claim generation. Marketing consent and operations-admin safety escalation retain their separate audience contracts.
- Leases, cursors, attempts, tickets, receipt state, subscriber indexes and retry metadata are
  client-write denied.
- Existing-record queue/job/attempt transactions tolerate a cold Admin SDK cache: a provisional
  null proposes a null no-op for the server comparison. Acquisition, progress and removal require
  the final accepted existing record and the operation's exact owner/status/version predicates;
  `committed: true` on an absent-record no-op never grants a lease. Bounded one-off due queries do
  not imply retained cache, and missing jobs/attempts are never recreated by these continuations.
- Audience processing is paged until exhaustion. There is no recipient-count cap.
- Eligibility is evaluated at send time. Skip counts distinguish `no_token`, `permission_denied`,
  `permission_blocked`, `permission_unavailable`, `inactive_token`, `invalid_token`, `opted_out`,
  `inactive_operational_session`, `wrong_tour`, `duplicate_token`, `sender_excluded`, and
  `expired_job`.
- Ticket, receipt and job timestamps are epoch milliseconds. Retry delay is bounded exponential
  backoff. Provider receipt checks start approximately 15 minutes after ticket creation and expire
  after 24 hours.
- Delivery accounting keeps Expo ticket acceptance, provider acceptance, known rejection and
  submission-unknown outcomes distinct. Provider acceptance confirms provider handoff only, never
  device display. An all-unknown attempted audience resolves to `submission_unknown`, not `partial`.

## Retention

- Ordinary notification jobs and their attempts remain for at least 30 days after the job's immutable
  first `completedAtMs`. Recognised terminal jobs are `ticket_rejected`, `provider_accepted`,
  `provider_rejected`, `partial`, `submission_unknown`, `expired`, and `no_recipients`.
- A server-owned `retentionDueAtMs` may be written once as `completedAtMs + 30 days`. It is discovery
  metadata, never delivery authority, and later status/source refreshes must not move it.
- Missing, malformed, non-terminal, leased, retrying/requeued, transitioning, or explicitly held jobs
  fail closed. `updatedAtMs` by itself never makes a job eligible.
- Account-deletion `privacy_deleted` jobs are content-free anti-recreation tombstones. Ordinary
  retention must not schedule them or shorten their explicit tombstone expiry; they become eligible
  only at that expiry.
- Retention work is private and durable under `notification_retention/v2`. A due queue discovers work,
  a leased job advances through bounded attempt pages and child/source cleanup phases, and every
  destructive page rereads the canonical notification job and exact rollout revision.
- `notification_retention_rollout/v2` is the server-owned authority. Missing or malformed state means
  fail-closed, non-destructive `legacy`; `paused` is the explicit operational stop phase. A shadow
  pass binds its aggregate fingerprint and revision; the first `compactor` revision
  remains paused with `canaryPassed=false`. A bounded canary binds its own fingerprint and revision,
  and only a second compare-safe compactor transition activates scheduled deletion.
- Attempt, recipient, UID/token-claim, runnable-queue, warning, coalescing, marketing-detail, and owned
  source cleanup is compare-safe. A source or coalescing pointer that no longer names the retained job
  is preserved.
- The parent job is deleted last. A crash before that point leaves resumable private state; a crash
  after it cannot expose a live child as delivery authority because delivery/retry paths require the
  canonical job and its current generation.
- Destructive pages carry a per-unit durable commit marker and an extended lease longer than the
  scheduled Function timeout. The first successful mutation also once-writes cumulative
  `irreversibleWorkStarted`, `firstDestructiveCommitAtMs`, and `committedDeletionCount` state and
  mirrors the boundary on the canonical fence. Rollout change, attention handling, manual requeue and
  ordinary cleanup cannot cancel that cumulative ownership; only exact retention recovery may finish it.
- Orphan repair is key-paged, timestamp-watermarked, and bounded. It never treats an orphan attempt or
  queue pointer as delivery authority and never scans an unbounded root in one invocation.
- A processing manual requeue persists `recoveryDueAtMs`. The scheduled retention worker resumes it
  through a rollout-bound compound cursor, so an unrecoverable bounded prefix cannot starve later
  crashed requeues. Completed states clear the recovery field before ordinary one-hour expiry.
- Legacy compatibility cleanup is deliberately inert. Historical attempts without `retentionDueAtMs`
  are discovered by a separate protocol-bound preparation stage ordered by exact
  `(updatedAtMs, attemptId)` cursor before orphan discovery may complete.
- Preparation, shadow, canary and rollout evidence bind a deterministic engine protocol ID plus
  byte-derived source, exact rules and trigger digests. The scheduled Function writes the matching
  server-owned heartbeat. A guarded production probe separately attests the deployed RTDB rules,
  Functions v2 runtime/region/timeout/instance configuration and scheduler identity/cron/timezone;
  stale, missing or mismatched heartbeat or deployment proof forces `paused` before deletion.
- Marketing detail records remain through explicit expiry and then no more than 30 additional days.
  Audience previews and manual-requeue state retain their existing ten-minute and one-hour lifetimes.

## Endpoint authentication boundary

Device registration, marketing detail and safety detail endpoints require a current Firebase ID token
and enforce self, assignment or operations-admin authority on the server. App Check enforcement and
configuration are intentionally unchanged in this release because App Check is not currently enabled
for the app; enabling it requires a separate coordinated mobile/server rollout rather than a partial
notification-only change.

### Device cleanup ownership

`notification_devices/{uid}/authoritySessionId` is server-controlled cleanup
ownership, independent of operational delivery eligibility. Registration and
preference reconciliation derive it from the authenticated UID's current, active,
unexpired canonical app session, including the first unassigned-driver or
marketing-only device. They never copy a client-supplied ID or retain an obsolete
tag as evidence. A supplied session ID must match that verified authority;
mismatched, missing or expired requested authority is an ignored stale mutation.
The capability-reducing `logout` action also accepts exact server-owned device
proof for an ended/expired session when no different canonical session exists:
mobile ends the session before sending notification logout. This preserves
consented marketing or removes the token without consent; it cannot enable
operational delivery or authorise stale registration/preferences.
Clients without a supplied session ID retain marketing-only behaviour only while
logged out. An active canonical session requires its exact supplied session ID.
Consent, permission and operational eligibility keep their separate checks.

Registration holds both existing locks without advancing the canonical session
revision. One restricted publication updates device, consent and audience
atomically. Server rules compare the operation, current installation authority,
device/tombstone revisions and absolute expiry at arrival, including an SDK write
queued offline before takeover. Already-applied retries retain the canonical
registration revision and never recreate partial or superseded projections.

Cleanup requires an exact `authoritySessionId`, or an exact legacy
`operationalSessionId` when no ownership tag exists. Equality with a device
snapshot is never proof of ownership. Unknown-owner legacy marketing state is
preserved; canonical session revocation still removes operational access.
Permanent account-deletion tombstones remain authoritative and block device
recreation. Clients cannot write any notification-device field, including the
ownership tag; this existing RTDB rule boundary is unchanged.

## Coordinated Expo enhanced-security procedure

1. Create the Expo access token in Secret Manager and deploy server support with the secret bound.
2. Run a full server-pipeline test and verify ticket plus receipt processing.
3. Enable enhanced push security in EAS.
4. Repeat the server-pipeline test.
5. If validation fails, disable enhanced security while retaining the server secret and investigate
   the visible `InvalidCredentials`/configuration warning. Never commit the token.


## First public launch protocol (24 October 2026)

New producers create schema-2 `notif_v2_` jobs and pin `audienceContract: indexed_v1`.
All delivery jobs, attempts, recipient/token/audience claims, coalescing, previews,
manual requeue work and runnable queues use distinct `_v2` private roots. Retention
uses `notification_retention/v2` and `notification_retention_rollout/v2`. Public
business sources, notification device ownership, consent and read state retain
their existing roots. Older delivery roots are preserved, not assumed synthetic
and not read by launch workers. Replayed old queue writes cannot enter new queues.
Old deployed provider workers must still be stopped/drained before activation;
namespace isolation is not evidence that an already-issued old provider request
was cancelled. No shared-data reset is part of repository preparation.

Attempt transitions compare generation, queue version, status and exact submission/
retry owner in a transaction at one attempt. A durable `publicationPending` outbox
records the prior pointer until the replacement pointer and accounting publish.
Every recovery first resumes that publication. Delayed workers cannot overwrite a
successor. Bounded preparation drains already-admitted siblings on error before
relinquishing the page; no further candidates are admitted after failure.

Accounting is internal exactly-once accounting, not exactly-once push display.
Each of 256 job hash shards retains latest per-attempt version and contribution;
a shard has a hard 1,024-attempt cap. Job transactions compare shard revisions and
apply their aggregate differences once, with at most 256 summaries on the job.
A crash or duplicate/older publication cannot add a phantom retry. The cap fails
closed before provider submission and must alert rather than evict a receipt.
After retention drains attempts it replaces accounting contents with 256 compact,
permanent shard tombstones so late publishers cannot recreate recipient ledgers.

Expo admission uses one project-shared RTDB budget across fanout and retries:
500 messages across two adjacent one-second buckets, with marketing capped at 300
and 200 reserved for operational traffic. At most 100 messages are sent per request.
An ambiguous timeout or malformed/missing ticket is terminal `submission_unknown`;
no automatic resend occurs. A ticket/receipt is not proof of display.

Queue entries carry indexed `serviceKey = lane~paddedDueTime`. Recovery queries
critical, operational and marketing lanes separately. Fanout recovery runs each
minute with 30 entries (10/lane); receipt reconciliation runs each minute with 999
entries (333/lane), and retries with 300 (100/lane). Receipt first-due remains 15
minutes after ticket, within Expo's 24-hour receipt window. These are bounded work
budgets, not certified cloud throughput; see the executable scale workload and
`docs/performance/notification-launch-capacity.md`.

Signed-in registration always supplies the exact current session, including an
unassigned/ineligible driver. Ownership comes from committed server publication,
not operational eligibility. Normal canonical session end precedes notification
logout: exact `authoritySessionId` or an already-applied exact logout tag authorizes
the reduction using stored consent. Untagged old devices do not acquire a special
logout exception. Successor publication, deletion and tombstones dominate old
requests. Consent-off logout retires the token; consent-on logout can retain
marketing alone, and never operational authority.


Current registration publication is atomic across the device, consent and all ten
category membership leaves. `notification_mutation_authority/{uid}` captures a
bounded operation manifest, exact installation epoch, existing device/tombstone
revisions and absolute expiry. A separate limited-privilege Admin SDK connection
must satisfy the root rules at server commit. Top-level internal issuer fields
are not client custom claims. Already-dispatched offline writes cannot overwrite
successor consent or recreate deleted delivery. Retry reads canonical authority;
no partial-projection repair or legacy ownership promotion is needed.
For active drivers, the arrival gate also checks current staff generation, login
policy, single-device claim and exact assignment. Passenger publication captures
the private booking reference, raw source tour and deletion-barrier key after
normalizing the source against the current session tour. Arrival rechecks that
source, eligibility, roster membership, private device authorization and exact
participant session. Transfer, cancellation, staff revocation or assignment
changes therefore fence queued work before a separate session cleanup completes.

The accounting wire format uses a fixed seven-value vector in this order:
`ticketAccepted, ticketRejected, receiptPending, receiptAccepted, receiptRejected,
retrying, submissionUnknown`. Public job/source count names are unchanged. The
vector avoids repeating long field names in each attempt and every bounded job
summary. Reservation expiry is checked with a fresh provider clock immediately
before dispatch; late budget acknowledgements consume capacity but cause safe
retry without provider submission. Budget denial does not consume a retry attempt.

Source delivery projections carry a monotonic sequence derived from bounded shard revisions plus audience progress. An older snapshot cannot overwrite later counters or terminal status merely because its wall clock is newer. Retry and manual requeue candidates use the same canonical indexed device, consent and membership revisions as first discovery; a removed device never falls back to a historical profile token.

Job expiry, coalescing and availability rescheduling also compare the exact
observed job in an existing-record transaction. They cannot recreate a removed
job or overwrite a successor worker or retention fence. A replacement queue
pointer is published before the previous pointer is retired. Terminal jobs keep
the previous pointer until source publication and retention scheduling succeed;
a stale-pointer replay completes that handoff before deleting its pointer.
