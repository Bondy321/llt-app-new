# Notification reliability rollout and device verification

This runbook is the release boundary for the durable notification system described in
`docs/architecture/decisions/0007-durable-notification-outbox.md`. It does not authorise a deployment
from a development task. Production changes require the normal reviewed release process.

## Required rollout order

1. Create `EXPO_ACCESS_TOKEN` in Google Secret Manager and grant the Functions runtime access. Keep
   Expo enhanced push security disabled at this point.
2. Deploy Realtime Database rules for the server-private fan-out, attempt-retry and receipt-due
   queue roots. These roots contain only runnable work; clients, including administrators, cannot
   read or write them.
3. Deploy the new Functions exports, including the source-retrying outbox producers, queue worker,
   recovery schedule, single-owner attempt retry/receipt processor, registration/detail/admin
   endpoints and retention schedule.
4. Deploy the web-admin notification workspace. Run a current-device full server test and observe a
   ticket ID followed by a provider receipt outcome.
5. Run `npm --prefix functions run migrate:notification-devices` in dry-run mode. Review every page,
   then repeat each page with `--apply --confirm-project=<exact-project-id>`. The migration only adds
   absent device/consent projections and preserves legacy user token fields. Confirm the final page
   reports `migrationComplete: true`; do not pass `--disable-legacy-fallback` during initial rollout.
6. Publish the mobile client containing the coordinator, versioned channels and detail routes.
   Functions must already be available because this client depends on their authenticated endpoints.
7. Monitor both `notification_devices` and the legacy `users/{uid}` fallback during the compatibility
   window. A canonical device record always suppresses its matching legacy record, including when
   its token is explicitly null or its permission/eligibility is false. Do not disable the legacy
   phase in this release.
8. After server tests are healthy, enable Expo enhanced push security in EAS and repeat the complete
   ticket/receipt test.
9. In a later reviewed release, after the compatibility window and a fresh final-page dry run, apply
   that final page with `--apply --confirm-project=<exact-project-id> --disable-legacy-fallback`.
   This writes the server-owned migration cutoff; it does not delete legacy profile fields.

Rollback is deliberately asymmetric: first disable enhanced push security if credentials fail,
then roll the mobile update back through the normal channel if required. Keep the Functions outbox
and rules deployed while jobs or receipts are outstanding. Do not restore direct source-trigger
sends; pause producers or the worker through a reviewed operational change if necessary.

## Retention and operational review

- Notification jobs, hashed-token attempts, tickets and receipts remain for at least 30 days after
  the immutable first job completion. `updatedAtMs` alone is not an eligibility boundary.
- Active, retrying, requeued, leased, transitioning, held, malformed and unknown-status jobs fail
  closed. The worker rereads the canonical job before every bounded destructive page.
- Account-deletion `privacy_deleted` jobs are content-free anti-recreation fences. They remain until
  their explicit tombstone expiry; ordinary job retention cannot shorten that lifetime.
- Marketing details remain through explicit expiry and then no more than 30 additional days.
- Delivery warnings, coalescing pointers and UID/token claims are compare-safely reconciled. A source
  or coalescing record that no longer points to the retained job is preserved.
- Runnable queue entries are removed only when their target, version and owner still match. A queue
  item is not reporting or delivery authority.
- Admin audience-preview state remains server-private and expires after 10 minutes. Admin requeue
  state remains server-private, expires after one hour, and retains its durable generation/cursor.
- Existing broadcast history remains an operations-owned business record; compaction removes it only
  where the notification source contract explicitly owns that deletion.

## Retention rollout

Code deployment is compatibility-first. The private `notification_retention_rollout/v1` record has
three phases: `legacy`, `shadow`, and `compactor`. Missing state means `legacy`; malformed state
disables destructive compaction. Every transition is an expected-phase/expected-revision transaction.

1. Deploy RTDB rules first so the new roots are private and the canonical discovery indexes exist.
2. Deploy Functions while rollout remains `legacy`. Confirm the stable
   `cleanupNotificationDeliveryData` export and new retention worker exports are active.
3. Run the retention preflight in default dry-run mode. Keep only aggregate counts and hashed cursors.
4. Run guarded preparation pages with `--apply --confirm-project=<exact-project-id>` until the durable
   progress record is complete. Preparation may add retention metadata/work; it deletes no canonical
   notification data.
5. Compare-and-set the rollout to `shadow`. The compactor plans bounded work but is not authoritative;
   safety mismatches, budget breaches or malformed candidates fail the gate.
6. Persist a passing bounded shadow comparison, then compare-and-set the exact shadow revision to the
   paused `compactor` gate using the matching preparation evidence digest. While `canaryPassed=false`,
   scheduled and normal cycles perform no retention mutation.
7. Run one synchronous bounded canary through the exact production compactor code. The first canary is
   one ordinary job and at most one 250-attempt page; it must leave no unexpected child/queue/orphan and
   no retention warning. Persist and fingerprint the result against the paused rollout revision.
   On any failure, compare-and-set the rollout back to `legacy` and process no further jobs.
8. Compare-and-set the paused compactor revision to active `compactor` with
   `--activate-after-canary`. Permit one normal bounded invocation only after that activation succeeds.

The rollout manager defaults to read-only. Every mutation requires `--apply`, exact project
confirmation, the observed rollout revision, and the current evidence digest for forward transitions.
A transition back to `legacy` needs no forward gate. It increments the revision, fencing stale worker
workers before another destructive page or phase; at most an already-started bounded page can settle.
Preserve retention jobs, queues, progress, evidence and warnings during rollback.

Synchronous production evidence consists of deployed Function/rule inspection, exact-head CI,
aggregate preflight/preparation output, bounded shadow counters, bounded canary residual checks,
rollout rereads and masked Function logs. Retention activation does not require a physical device,
billing comparison, a multi-day wait or human-only observation.

`ticket_accepted` means Expo accepted the request. `provider_accepted` means Expo later returned a
successful receipt. Neither status proves the device displayed the notification.

## Physical-device release matrix

Record device model, OS version, app build, Firebase project, timestamp, job ID and final receipt
status for every run. Never mark an item passed from a simulator, unit test or provider ticket alone.

| Scenario | iOS release build | Android release build | Evidence required |
| --- | --- | --- | --- |
| First install and custom explanation | Pending | Pending | Screenshot before native prompt |
| Grant, deny, blocked, settings return | Pending | Pending | UI state and server device projection |
| iOS provisional/quiet delivery | Pending | N/A | Native permission status and presentation |
| Foreground, background, terminated tap | Pending | Pending | Exact route and non-replay after restart |
| Forced token replacement | Pending | Pending | Old/new token hashes and compare-safe state |
| Offline registration then reconnect | Pending | Pending | Durable retry and eventual projection update |
| Passenger chat and group photo | Pending | Pending | Job, ticket, receipt and correct destination |
| Itinerary and Driver Tour Pack | Pending | Pending | Coalescing/supersession and exact destination |
| Safety and SOS | Pending | Pending | Sanitised lock screen, exact authorised event, warning path |
| Tour and future-tour broadcast | Pending | Pending | Preview, job, receipt and durable marketing detail |
| Marketing after logout and opt-out | Pending | Pending | Operational false, consent preservation/removal |
| DeviceNotRegistered | Pending | Pending | Receipt rejection and matching-token-only cleanup |
| Invalid APNs/FCM credentials in non-production | Pending | Pending | Visible configuration warning; no production disruption |

## Release gate

Do not enable enhanced push security, remove legacy token fallback, or approve the mobile release
until the focused notification suites, full repository validation, emulator rules suite, web build,
Expo Doctor and both platform exports pass. External APNs/FCM credentials and physical devices are
release prerequisites, not outcomes that can be inferred from repository tests.

Record deployment, preparation, shadow, canary and activation evidence in the release report rather
than embedding an environment snapshot in this runbook. Expo enhanced security, App Check, mobile
publication and physical-device notification verification remain separate release boundaries.
