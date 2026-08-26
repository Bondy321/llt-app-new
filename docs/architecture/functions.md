# Firebase Functions architecture

Notification producers retain their deployed export names but only persist deterministic records in
`notification_jobs`. `processNotificationDeliveryJob` is the sole Expo send boundary;
`recoverNotificationDeliveryJobs` resumes stranded leases, `processNotificationReceipts` owns Expo
receipt reconciliation, and `cleanupNotificationDeliveryData` applies bounded retention. See ADR
0007 and `docs/data-contracts/notification-delivery.md` before modifying a notification producer.

`functions/index.js` imports and re-exports `functions/src/compositionRoot.js`. The composition root registers every deployed object exactly once. Domains contain business policy; infrastructure contains reusable runtime mechanics and may not make domain decisions.

Domains currently cover administration, app sessions, driver assignment, driver authentication, driver Tour Packs, maintenance, manifests, media, notifications, passenger authentication, and safety. Infrastructure covers auth, database operations, HTTP boundaries, safe logging, notifications, distributed rate limits, and Storage/media processing.

Firebase Admin initialization is centralized. `sharp` is isolated to `infrastructure/storage/mediaProcessor.js`; `expo-server-sdk` is isolated to notification infrastructure. Importing the composition root must not eagerly load either package.

To add a Function:

1. Put validation and decisions in the correct domain.
2. Reuse injected HTTP/auth/database/logging infrastructure.
3. Define the Gen 2 trigger with the existing region/resource conventions.
4. Export it once from `compositionRoot.js`.
5. Add its export name and trigger configuration to characterization tests.
6. Keep `functions/index.js` free of paths, parsing, and rules.

Never rename deployed exports or alter regions, paths, schedules, resource settings, CORS, request shapes, or reason codes without a compatibility layer.
