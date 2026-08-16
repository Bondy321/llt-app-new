# Operational Update Integrity

Date: 12 August 2026

This contract covers the three operational paths that must remain consistent from Firebase through the mobile UI: tour notifications, itinerary updates, and passenger-manifest reconciliation.

## 1. Durable tour notifications

Server-owned notice records live at:

```text
tour_notifications/{tourId}/{noticeId}
```

Supported records are `announcement` and `itinerary`. Each record contains version, type, title, body, canonical `tourId`, destination screen, source ID, optional exact chat `messageId`, priority, and both ISO/numeric creation timestamps. Cloud Functions derive deterministic notice IDs from the tour, type, and source. Repeated delivery is idempotent and each tour retains the newest 100 notices.

Per-user read state lives at:

```text
notification_read_state/{tourId}/{authUid}/{noticeId} = timestampMs
```

Mobile clients cannot create notice content. A tour participant or verified assigned driver may read the attached tour feed; an authenticated user may update only their own read branch. Tour deletion removes both roots.

`notificationInboxService` queries the newest 50 notices and overlays the caller's read state. Legacy announcement records without an explicit `messageId` derive it from their chat-backed `sourceId`.

`notificationService.subscribeToNotificationResponses` handles both the last cold-start response and live response events. Tour-scoped destinations (`Chat`, `Itinerary`, and `GroupPhotobook`) must match the active canonical tour. The global `NotificationPreferences` destination is allowed only after the app has restored an authenticated booking session, and carries the marketing `categoryKey` so the matching preference section opens automatically.

Cloud Functions use one push-navigation payload builder. Durable tour pushes carry `noticeId` so opening them clears the matching unread state. Chat announcements also carry `messageId`; the app first checks its bounded live window, then reads that one exact message path when necessary. Responses are held in an in-flight set to stop concurrent double navigation, but become permanently deduplicated only after navigation succeeds, so startup timing failures remain retryable.

## 2. Itinerary integrity

Passenger itinerary source:

```text
tours/{tourId}/itinerary
```

The mobile edit service validates a non-empty day array, content and payload bounds, then uses an RTDB transaction. The transaction compares a canonical content signature captured when editing started. Metadata-only changes do not create false conflicts. A successful write adds/increments `revision` and records numeric `updatedAt` plus `updatedBy`.

If the server content changed, the transaction aborts. The newer server itinerary is loaded and cached while the driver's draft remains open until they explicitly choose the server copy or continue reviewing their draft. A stale edit never silently overwrites the server.

Passenger and driver caches share the Tour Pack contract:

```text
tour_pack_v2_passenger_<tourId>_<encodedBookingRef>.itinerary
tour_pack_v2_driver_<tourId>_<encodedDriverId>.itinerary
tour_pack_v2_driver_<tourId>_<encodedDriverId>.driverItinerary
```

Tour Pack partial writes are serialized per tour, role, and login identity. A remote deletion stores a null tombstone for that field without deleting the rest of the pack. The legacy `driver_itinerary_<tourId>` key is read once, migrated into the active driver's pack, and removed.

Driver operational itinerary text remains a bounded string at `tours/{tourId}/driver_itinerary`; the RTDB rule intentionally matches that mobile contract.

## 3. Passenger manifest reconciliation

Manifest booking state lives at:

```text
tour_manifests/{tourId}/bookings/{bookingRef}
```

Direct and replayed writes use one RTDB transaction. If `server.lastUpdated` is newer than the attempted update, the callback aborts and returns a structured conflict containing both attempted state and the exact server-preserved status, per-passenger statuses, and timestamp. Idempotency keys make a repeated delivery a no-op success.

Offline queue rules:

- `MANIFEST_UPDATE` entries are keyed by canonical tour and booking for supersession.
- A newer entry removes an older queued/retry/failed entry for that same tour and booking; it never removes another tour's work or an in-flight entry.
- Replay returns per-action outcomes before processed entries are removed, so a server-win result remains visible to the operator.
- Manifest queue badges, totals, retry actions, and conflict cards are filtered to the active tour.
- While offline, the requested status is shown optimistically with a queued badge; a subsequent server conflict replaces it with the protected server state and a review action.

## Verification gates

Run at minimum:

```text
npm run test:mobile:services:notifications
npm run test:mobile:services:itinerary
npm run test:mobile:services:booking
npm run test:mobile:sync:engine
npm run test:emulators:firebase-rules
```

Changes to Functions or RTDB rules must be deployed before a mobile release that relies on these contracts. No OTA or store release is implied by a backend deployment.
