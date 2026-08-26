# Notification reliability rollout and device verification

This runbook is the release boundary for the durable notification system described in
`docs/architecture/decisions/0007-durable-notification-outbox.md`. It does not authorise a deployment
from a development task. Production changes require the normal reviewed release process.

## Required rollout order

1. Create `EXPO_ACCESS_TOKEN` in Google Secret Manager and grant the Functions runtime access. Keep
   Expo enhanced push security disabled at this point.
2. Deploy the new Functions exports, including the outbox worker, recovery schedule, receipt
   processor, registration/detail/admin endpoints and retention schedule.
3. Deploy Realtime Database rules and indexes for the server-private notification roots.
4. Deploy the web-admin notification workspace. Run a current-device full server test and observe a
   ticket ID followed by a provider receipt outcome.
5. Run `npm --prefix functions run migrate:notification-devices` in dry-run mode. Review every page,
   then repeat each page with `--apply --confirm-project=<exact-project-id>`. The migration only adds
   absent device/consent projections and preserves legacy user token fields.
6. Publish the mobile client containing the coordinator, versioned channels and detail routes.
   Functions must already be available because this client depends on their authenticated endpoints.
7. Monitor both `notification_devices` and the legacy `users/{uid}` fallback during the compatibility
   window. Do not remove the legacy fallback in this release.
8. After server tests are healthy, enable Expo enhanced push security in EAS and repeat the complete
   ticket/receipt test.

Rollback is deliberately asymmetric: first disable enhanced push security if credentials fail,
then roll the mobile update back through the normal channel if required. Keep the Functions outbox
and rules deployed while jobs or receipts are outstanding. Do not restore direct source-trigger
sends; pause producers or the worker through a reviewed operational change if necessary.

## Retention and operational review

- Notification jobs, hashed-token attempts, tickets and receipts: 30 days after their last update.
- Marketing details: bounded expiry, then no more than 30 additional days.
- Delivery warnings: removed with their retained job; open warnings remain visible during that
  window.
- Coalescing and duplicate-token claims: compare-safely removed with the retained job.
- Existing broadcast history: retained for operations during rollout; a later reviewed retention
  migration should apply the business-record retention period rather than deleting it implicitly.

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
