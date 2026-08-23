# Operational Update Integrity

Date: 23 August 2026

This contract covers the three operational paths that must remain consistent from Firebase through the mobile UI: tour notifications, itinerary updates, and passenger-manifest reconciliation.

## 1. Durable tour notifications

Server-owned notice records live at:

```text
tour_notifications/{tourId}/{noticeId}
```

Supported records are `announcement`, `itinerary`, and `driver_tour_pack`. Each record contains version, type, title, body, canonical `tourId`, destination screen, source ID, optional exact chat `messageId`, priority, and both ISO/numeric creation timestamps. Driver Tour Pack notices additionally carry only bounded semantic routing metadata (`departureKey`, revision, changed sections, criticality, and acknowledgement requirement), never operational pack content. Cloud Functions derive deterministic notice IDs from the tour, type, and source. Repeated delivery is idempotent and each tour retains the newest 100 notices.

Per-user read state lives at:

```text
notification_read_state/{tourId}/{canonicalPrincipalKey}/{noticeId} = timestampMs
```

Mobile clients cannot create notice content. A tour participant may read/write only the branch matching the stable passenger key currently bound to their authenticated profile; a verified assigned driver may use only `driver:{driverId}`. A UID branch is accepted only for a legacy participant that has no stable passenger binding. Every write must reference an existing notice on the same attached tour, so outsiders and stale application principals cannot inherit or create read state. On the first canonical-principal subscription, the client writes one exact `notification_read_migration_requests/{tourId}/{authUid}` request. Rules bind that request to the caller's current passenger/driver profile. Because a reusable anonymous UID cannot prove which application principal created old markers on a shared device, the retry-enabled `processNotificationReadMigrationRequest` Function deletes the ambiguous legacy UID branch rather than copying it, removes the request, and records completion inside the authenticated user profile. That marker blocks repeat work and is automatically removed with the user during account deletion. Affected pre-upgrade notices can appear unread once; no passenger's activity is attributed to another. To cover users who never reopen the inbox, the scheduled worker performs one shallow tour-key discovery, persists a server-private legacy cleanup queue, and then consumes one tour in RTDB key-ordered pages of at most 50 principals per invocation. It never copies legacy history: canonical passenger/driver keys and live Auth users with a legitimate UID-only fallback are preserved, while obsolete UID branches for profiles now bound to a stable passenger/driver identity and orphan branches whose Auth account no longer exists are deleted. Removing a tour also removes its queued cleanup item, so concurrent tour deletion cannot strand or skip later work. When Functions evict an old notice from the 100-record feed they enqueue one exact, idempotent record under the server-private `notification_read_cleanup_jobs` root. `cleanupNotificationReadState` runs every 15 minutes, processes at most 10 jobs, advances each job through at most 50 principals per invocation, and removes only the evicted notice leaf before continuing from its durable cursor. Notification delivery therefore never scans a tour-wide read-state fanout. Tour deletion removes the public notice/read roots; an empty cleanup page then completes any residual job.

`notificationInboxService` queries the newest 50 notices and at most 100 numeric read-state leaves from the canonical principal branch, then overlays the caller's state. It stores a versioned, minimal, auth-UID + canonical passenger/driver principal + tour-scoped 30-day cache so missed pushes remain visible through a transient listener failure or offline reopen without crossing identities that reuse one anonymous Firebase UID. Cached results are explicitly labelled saved/stale, a failed live listener preserves the last usable feed and exposes retry, and logout/account deletion synchronously revokes every live feed subscription plus the UID cache generation before deleting indexed entries. Generation persistence and deletion each receive three immediate attempts so a transient storage error does not strand customer data. Cache writes are serialized; inactive listener callbacks and writes with the old generation are rejected, and corrupt/orphaned index data cannot be loaded after revocation. Legacy announcement records without an explicit `messageId` derive it from their chat-backed `sourceId`.

`notificationService.subscribeToNotificationResponses` handles both the last cold-start response and live response events. Tour-scoped destinations (`Chat`, `Itinerary`, `GroupPhotobook`, `SafetySupport`, and `DriverTourPack`) must match the active canonical tour. The global `NotificationPreferences` destination is allowed only after the app has restored an authenticated booking session. Category broadcasts must carry a supported canonical marketing `categoryKey` plus `broadcastId`; unknown or incomplete marketing routes are rejected rather than silently opening an unrelated screen.

Cloud Functions use one push-navigation payload builder. Durable tour pushes carry `noticeId` so opening them clears the matching unread state. Chat announcements also carry `messageId`; the app first checks its bounded live window, then reads that one exact message path when necessary. Responses are held in an in-flight set to stop concurrent double navigation, but become permanently deduplicated only after navigation succeeds, so startup timing failures remain retryable.

Preference loads fetch remote preferences and probe existing OS permission concurrently. A save prompts/probes at most once, passes the resolved decision into token registration, and persists permission, token, preference, app, and device state in the final bounded profile update. Push tokens must be canonical Expo token strings; provider, timestamps, invalid reason, app version/build, device model/OS, and OS version are length- and value-bounded by RTDB rules.

Category-broadcast delivery status counts Expo ticket acceptance, not confirmed device display. Receipt reconciliation and fair cursor-backed fanout beyond the current deterministic 1,000-recipient cap require a separate durable campaign-job contract before implementation.

## 2. Itinerary integrity

Passenger itinerary source:

```text
tours/{tourId}/itinerary
```

The mobile edit service validates a non-empty day array, content and payload bounds, then uses an RTDB transaction. The transaction compares a canonical content signature captured when editing started. Metadata-only changes do not create false conflicts. A successful write adds/increments `revision` and records numeric `updatedAt` plus `updatedBy`.

If the server content changed, the transaction aborts. The newer server itinerary is loaded and cached while the driver's draft remains intact. Publishing is disabled until the driver explicitly loads the protected server version or confirms that their reviewed draft should become the next revision. A stale edit never silently overwrites the server, and entering edit mode pauses realtime replacement so an incoming snapshot cannot erase typed changes.

Read semantics are deliberately three-state:

- A missing itinerary snapshot is an authoritative unpublished/withdrawn result and may store a cache tombstone.
- A failed Firebase read throws and must retain any identity-scoped cached itinerary.
- A successful snapshot is normalized at the service boundary. Legacy `activities` rows are converted into readable day content without dropping their original structured fields.

The mobile UI tracks source provenance as `live`, `cache`, or `none`. A saved copy is never labelled live, exposes its age, and provides a direct retry when live refresh fails. Freshness recalculates while the screen remains open instead of waiting for another render.

Passenger and driver caches share the Tour Pack contract:

```text
tour_pack_v2_passenger_<tourId>_<encodedBookingRef>.itinerary
tour_pack_v2_driver_<tourId>_<encodedDriverId>.itinerary
tour_pack_v2_driver_<tourId>_<encodedDriverId>.driverItinerary
```

Tour Pack partial writes are serialized per tour, role, and login identity. A remote deletion stores a null tombstone for that field without deleting the rest of the pack. The legacy `driver_itinerary_<tourId>` key is read once, migrated into the active driver's pack, and removed.

Tour Pack metadata writes are also serialized and merged. `lastSyncedAt` is monotonic, while resource-specific provenance uses `itineraryLastSyncedAt`, `itineraryRevision`, and `driverItineraryLastSyncedAt`. One screen must not erase or falsely refresh another resource's metadata.

Itinerary notification delivery uses an `onValueWritten` trigger so first publication, meaningful edits, and withdrawal all create durable notices and pushes. Metadata-only revision/timestamp writes do not notify. First publication uses “Itinerary available”; withdrawal uses “Itinerary being revised”.

Realtime Database validation permits the production formats (`title`, bounded `days`, optional importer `warnings`, optional legacy `title`/`activities`, and revision metadata) and rejects unbounded or unknown itinerary/day/activity fields. Numeric child-index validation caps days, activities, and warnings without relying on unsupported rule APIs.

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
