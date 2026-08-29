# Firebase Functions architecture

Notification producers retain their deployed export names but only persist deterministic records in
`notification_jobs`. `processNotificationDeliveryJob` is the sole Expo send boundary;
`recoverNotificationDeliveryJobs` resumes stranded leases, `processNotificationReceipts` owns Expo
receipt reconciliation, and `cleanupNotificationDeliveryData` applies bounded retention. See ADR
0007 and `docs/data-contracts/notification-delivery.md` before modifying a notification producer.

`functions/index.js` imports and re-exports `functions/src/compositionRoot.js`. The composition root registers every deployed object exactly once. Domains contain business policy; infrastructure contains reusable runtime mechanics and may not make domain decisions.

Domains currently cover account deletion, administration, app sessions, driver assignment, driver authentication, driver Tour Packs, live-state projections, maintenance, manifests, media, notifications, passenger authentication, and safety. Infrastructure covers auth, database operations, HTTP boundaries, safe logging, notifications, distributed rate limits, and Storage/media processing.

`domains/account-deletion` owns the authenticated request/status/retry protocol, trusted scope
derivation, non-expiring login barrier, private job/queue leases, bounded media/chat cursors, retry and
completion retention. The initial request supplies only an exact session ID and an opaque receipt;
Functions derive all customer/driver/tour ownership. Workers may commit only under an exact
owner/revision/phase lease, use the notification and media domains through internal trusted helpers,
progressively shred private scope, delete Firebase Auth last, and retain only a minimal receipt-derived
completion marker after detailed-record expiry. See ADR 0009, `docs/data-contracts/account-deletion.md`, and
`docs/operations/account-deletion.md` before changing this domain.

`domains/live-state` owns retryable RTDB triggers for private driver-location and
chat-status sources, the trusted assignment-owned pickup mutation, and private
revision-checked live-state rollout administration. The pure projection modules
live behind the legacy-library allowlist so session cleanup removes exact live
leaves without erasing durable pickups and reconciles unchanged client read paths.

Driver assignment is one server-owned mutation for both operations admins and
mobile self-assignment. The Function owns revision checks, sorted locks,
idempotency, canonical multi-root updates, active-session/device reconciliation,
and bounded audit events. Browser code may read revisions for optimistic input but
must never calculate or directly write assignment authority.

Firebase Admin initialization is centralized. `sharp` is isolated to `infrastructure/storage/mediaProcessor.js`; `expo-server-sdk` is isolated to notification infrastructure. Importing the composition root must not eagerly load either package.

To add a Function:

1. Put validation and decisions in the correct domain.
2. Reuse injected HTTP/auth/database/logging infrastructure.
3. Define the Gen 2 trigger with the existing region/resource conventions.
4. Export it once from `compositionRoot.js`.
5. Add its export name and trigger configuration to characterization tests.
6. Keep `functions/index.js` free of paths, parsing, and rules.

Never rename deployed exports or alter regions, paths, schedules, resource settings, CORS, request shapes, or reason codes without a compatibility layer.

The prepared account-deletion public exports are `requestAccountDeletion`,
`getAccountDeletionStatus`, and `retryAccountDeletion`. `processAccountDeletionJobs` is the private
five-minute scheduler that claims at most 10 due jobs and removes at most 50 expired completion records
per run. Their existence in source does not mean they have been deployed.
