# ADR 0007: Durable notification outbox and provider receipts

Status: accepted.

## Context

Notification source triggers previously selected recipients and called Expo during the same Firebase
invocation. A crash or temporary provider failure could therefore lose an event, repeat a partial
fan-out, or stop after the first 1,000 recipients. Expo ticket acceptance was also the last observed
state even though it does not prove provider acceptance or device display.

## Decision

Keep every existing source trigger export and Firebase source path, but make the trigger's durable
result a deterministic record under `notification_jobs/{jobId}`. The job is the source of truth.

`processNotificationDeliveryJob` reacts to runnable job writes. It acquires a transactional lease,
reads one bounded page of current notification-device/user records, re-evaluates current session,
tour, permission, token and consent state, sends deterministic Expo chunks, stores per-recipient
attempts and ticket IDs, and persists its continuation cursor. Writing the next runnable state causes
the following page to be processed. `recoverNotificationDeliveryJobs` recovers expired leases and
jobs whose trigger invocation was lost.

`processNotificationReceipts` checks due Expo receipts in provider batches no larger than 1,000,
distinguishes ticket acceptance from provider acceptance, performs compare-safe invalid-token
cleanup, retries temporary failures inside the 24-hour receipt window, and surfaces configuration
failures. `cleanupNotificationDeliveryData` bounds retention.

Raw Expo tokens remain only in the approved `notification_devices` projection and the legacy
`users/{uid}` compatibility field. Jobs never contain tokens. Delivery attempts contain only a
SHA-256 token hash, recipient/installation UID, ticket ID, bounded status and safe error codes.

Operational fan-out pages over current device records and still requires a current matching
`app_sessions` record plus tour membership or coherent driver assignment. Marketing fan-out requires
explicit category consent but not an operational app session. The worker reads mutable state fresh;
there is no process-local profile or permission cache.

State-like itinerary and Driver Tour Pack jobs use a coalescing key. Enqueuing a newer semantic
revision marks an older runnable job as superseded. Chat, photos and distinct safety incidents do not
collapse.

## Compatibility and rollout

- Existing trigger export names, source paths and legacy mobile routes remain available.
- New Android channel IDs are versioned; `default` remains configured for old clients.
- Device registration is server-mediated, but the worker dual-reads legacy user token fields during
  migration.
- Functions and server-private rules must be released before a mobile client depends on device
  registration or new notification-detail routes.
- No App Check setting is changed by this decision.

## Rejected alternatives

- Immediate provider sends: not recoverable or idempotent across partial failure.
- Process-local throttles/caches: neither distributed nor authoritative.
- A random job ID: permits duplicate delivery when Firebase retries the same source event.
- Treating Expo tickets as delivery: ticket acceptance only means Expo accepted the request.

