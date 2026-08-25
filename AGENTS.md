# Loch Lomond Travel (LLT) App - Agent Onboarding

Welcome, Agent. This file is the operational source of truth for contributors working in this repo. Keep it practical: update it whenever architecture, contracts, commands, or release assumptions materially change.

Last updated: August 21, 2026

Architecture source of truth: start with `docs/architecture/overview.md`, then follow `module-boundaries.md` and the runtime-specific document. Keep `App.js` and `functions/index.js` as composition roots; preserve compatibility facades; place Firebase, HTTP, and persistence access behind adapters; update canonical contracts and generated copies together; run `npm run verify:refactor` for structural changes. The detailed rationale lives in `docs/architecture/decisions/` and should not be duplicated here.

---

## 1. What This Repo Is

LLT is a production-oriented monorepo for Loch Lomond Travel:

- Mobile app: Expo / React Native passenger and driver app.
- Web admin: React + Vite + Mantine dashboard for the operations team.
- Firebase backend: Realtime Database, Storage, Cloud Functions Gen 2, and security rules.

High-level data flow:

```text
Google Sheets CMS
  -> Apps Script sync
     -> Firebase Realtime Database
        -> Mobile app
        -> Web admin
        -> Cloud Functions
        -> Expo push notifications
```

Firebase project default: `loch-lomond-travel` from `.firebaserc`.

Backend region rule:

- Most Cloud Functions and RTDB-triggered backend work must stay in `europe-west1`.
- Intentional exception: `generatePhotoVariants` is in `us-east1` because Firebase Storage triggers must match the default Storage bucket region.

---

## 2. Current Stack

Mobile:

- Expo SDK `55` (`expo ~55.0.28`)
- React Native `0.83.10`
- React `19.2.0`
- Firebase JS SDK `^12.17.1`
- `expo-notifications ~55.0.25`
- `expo-image ~55.0.11`
- `expo-image-manipulator ~55.0.19`
- `expo-file-system ~55.0.24`
- `expo-secure-store ~55.0.16`
- `@react-native-async-storage/async-storage 2.2.0`
- `react-native-maps 1.27.2`
- Import `MaterialCommunityIcons` from `@expo/vector-icons/build/MaterialCommunityIcons.js`; the package barrel causes Metro to emit every icon font family and the package shim is not directly resolvable by Node 24 tests.

Web admin:

- React `^19.2.0`
- Vite `^7.3.6`
- Mantine `^8.3.9`
- React Router `^7.18.2`
- Firebase JS SDK `^12.17.1`
- Vitest `^4.1.10`

Functions:

- Cloud Functions Gen 2 only
- Node runtime target `22`
- `firebase-functions ^7.3.2`
- `firebase-admin ^13.7.0`
- `expo-server-sdk ^4.0.0`
- `sharp ^0.33.5`

---

## 3. Repository Map

```text
App.js                         Mobile app shell, session restore, screen routing
app.config.js                  Expo config, permissions, runtimeVersion policy
firebase.js                    Mobile Firebase init, auth persistence, RTDB connectivity
theme.js                       Mobile theme tokens
database.rules.json            Realtime Database rules
storage_rules.json             Firebase Storage rules
eas.json                       EAS build/update profiles

screens/                       Mobile screens
components/                    Shared mobile components
hooks/                         Mobile hooks
services/                      Mobile service layer and local persistence
utils/                         Pure mobile/shared logic utilities
tests/                         Node test suites and contract tests
__tests__/                     Additional service tests
docs/                          Contracts and operational runbooks
scripts/                       Root release/env helper scripts
functions/                     Firebase Functions Gen 2 and maintenance scripts
web-admin/                     Vite React admin dashboard
```

Core mobile screens:

- `LoginScreen`, `TourHomeScreen`, `DriverHomeScreen`
- `PassengerManifestScreen`
- `DriverTourPackScreen` (feature-flagged Driver Command Centre)
- `ItineraryScreen`, `DriverItineraryScreen`
- `ChatScreen`
- `MapScreen` plus `MapScreen.web.js`
- `PhotobookScreen`, `GroupPhotobookScreen`
- `NotificationPreferencesScreen`
- `SafetySupportScreen`

Web admin routes:

- `/` -> `Dashboard`
- `/drivers` -> `DriversManager`
- `/tours` -> `ToursManager`
- `/broadcast` -> `BroadcastPanel`
- `/settings` -> `Settings`

---

## 4. Primary Data Roots

Do not rename these Realtime Database roots without a full migration:

- `drivers`
- `bookings`
- `tour_manifests`
- `tours`
- `chats`
- `internal_chats`
- `group_tour_photos`
- `private_tour_photos`
- `users`
- `identity_bindings`
- `identity_bindings_meta`
- `admin_users`
- `logs`
- `ops_alerts`
- `globalSafetyAlerts`
- `broadcasts`
- `category_broadcasts`
- `tour_notifications`
- `notification_read_state`
- `notification_read_cleanup_jobs` (server-private bounded continuation jobs)
- `web_admin_settings`
- `booking_identities`
- `passenger_identity_security` (server-only opaque identity and installation binding; never sync-owned)
- `manual_booking_creation_locks`
- `driver_tour_packs`
- `driver_tour_pack_actions`
- `driver_tour_pack_tombstones`
- `driver_tour_pack_ingestion`
- `driver_tour_pack_admin_status`
- `driver_tour_pack_feature_flags`
- `driver_tour_pack_progress`
- `driver_tour_pack_issues`
- `login_rate_limits` (server-private opaque abuse-prevention counters)
- `safety_rate_limits` (server-private opaque safety-submission counters)

Admin UID hardcoded in rules:

```text
9CWQ4705gVRkfW5Xki5LyvrmVp23
```

Admin-only roots include protected writes such as `bookings`, `broadcasts`, `category_broadcasts`, `booking_identities`, and many privileged mutations. The web admin signs out authenticated users who are not operations admins, and Realtime Database rules independently deny their protected operations as defense in depth.

Additional web-admin operators can be allowed through:

```text
admin_users/{authUid} = true
```

Only the hardcoded primary admin UID can manage this allowlist. Existing allowlisted admins
cannot grant or revoke admin access. Do not use user-owned settings or profile fields as
privilege signals.

---

## 5. Authentication and Identity

Firebase Auth foundation:

- Mobile uses anonymous auth and durable local session state.
- Web admin uses email/password auth.
- Mobile Firebase initialization lives in `firebase.js` and exposes `authHelpers`, `firebaseInitHealth`, `updateNetworkState`, compat Firestore/RTDB handles, modular RTDB, and Storage.

Passenger login:

- Entry is booking reference plus booking email.
- `services/bookingServiceRealtime.js` calls the `verifyPassengerLogin` HTTPS function.
- The verifier reads `booking_identities/{bookingRef}` and returns deterministic reason codes.
- Web-admin manual passenger creation must write the same `booking_identities/{bookingRef}` shape as the sync upload so the verifier can grant access normally.
- Client env flags:
  - `EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL`
  - `EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_TIMEOUT_MS`
  - `EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_USE_APPCHECK`
  - `EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_REQUIRE_APPCHECK`
- Backend App Check enforcement is controlled by `REQUIRE_APP_CHECK_FOR_LOGIN`. It is explicitly
  disabled with `false` until the production apps are registered; an omitted deployed setting still
  fails closed so configuration loss cannot silently change the mode.
- Login abuse quotas are authoritative RTDB transactions under opaque hashed
  `login_rate_limits/v1/*` buckets, shared by every Gen2 instance. The module-local limiter is not
  an acceptable authority for either login endpoint.
- Production/TestFlight workflows currently pin both client App Check flags and
  `LLT_REQUIRE_PRODUCTION_APPCHECK` to `false`. Enable all client and backend flags together only
  after a staged registration and token smoke test. Broad network quotas use only the trusted
  platform forwarding hop, never client IDs or User-Agent values. Expiry cleanup
  compare-and-deletes and drains bounded batches without deleting a concurrently reset bucket.

Driver login:

- Driver codes use `D-*` style identifiers.
- `verifyDriverLogin` validates the code, transactionally claims an unclaimed driver record
  for the authenticated Firebase UID, and writes the server-owned driver identity fields.
- Driver login resolves driver profile, assignment context, and driver home tour context.
- `assignDriverToTour` is the only mobile assignment mutation path; mobile clients never
  write driver, user-authority, tour-driver, or manifest-assignment nodes directly.
- Canonical driver principal for identity-sensitive paths is `driver:{DRIVER_ID}`.

Application session authority:

- Source contract: `docs/data-contracts/app-session.md`; rollout and operational response are in `docs/app-session-rollout.md` and `docs/app-session-operations-runbook.md`.
- `app_sessions/{authUid}` is the only authority that turns persistent mobile Firebase Auth into current app access. Clients read only their own record and cannot write any session field.
- Login Functions issue an opaque `sess_v1_{32 lowercase hex}` ID under a per-UID transactional `app_session_locks` lock. Passenger membership is server-owned schema v2 and must match the session ID, principal, tour and expiry.
- Driver access requires an active matching session in addition to every driver mapping and assignment. Operational assignment survives logout but is never sufficient for app access.
- Normal logout calls `endAppSession` with Auth, App Check and the exact expected session ID. Missing state is idempotent success; mismatched state returns `SESSION_CHANGED` and cannot end a newer login.
- Offline logout is a durable blocking pending state, not a completed logout. Startup retries it, and no tour UI may be restored while it is pending.
- Admin revocation uses `revokeAppSession`; session expiry cleanup runs every 15 minutes. Both share the same compare-safe cleanup and distributed lock boundary.
- Normal logout preserves Firebase Auth, `passenger_identity_security`, `authorizedAuthUid`, opaque passenger identity, historical content and operational driver assignment. Explicit account deletion remains a separate workflow.

Stable passenger identity:

- Canonical ID: opaque server-issued `pax_v2_{32 lowercase hex characters}`.
- Passenger principals must never contain booking reference, email, phone, name, or other customer data.
- `verifyPassengerLogin` transactionally creates/reuses the opaque ID and persists the user profile and bindings with Admin SDK authority. Clients never derive or bind passenger identities.
- A booking is bound to its first verified Firebase Auth UID through `passenger_identity_security/{bookingRef}/authorizedAuthUid`; a different UID receives `REAUTHORIZE_REQUIRED`. This server-only root is separate from sync-owned `booking_identities`, so imports cannot erase security state. Migration locks ambiguous multi-UID legacy bookings for operations review.
- The only client mutation allowed in `passenger_identity_security` is deletion of `authorizedAuthUid` by that exact currently bound UID during explicit account deletion; clients cannot read, create, replace, or reassign a security record.
- Use `toRealtimeKeySegment(stablePassengerId)` before using stable identities as path segments.
- Encoded keys are required for:
  - `identity_bindings/{stablePassengerKey}/{authUid}`
  - `identity_bindings_meta/{stablePassengerKey}`
  - `private_tour_photos/{tourId}/{stablePassengerKey}`
  - chat actor-scoped leaves when the actor ID is not RTDB-safe.
- User profiles should persist:
  - `stablePassengerId`
  - `stablePassengerKey`
  - `privatePhotoOwnerId`
  - `privatePhotoOwnerKey`
  - `identityVersion: "pax_v2"`
- Passenger-readable records and user profiles must not retain `normalizedPassengerEmail` as identity metadata. The verifier-only `booking_identities` root remains the private credential source; it must never own opaque identity or login-binding state.

Important helper:

- `services/identityService.js`
  - `getCanonicalIdentity`
  - `resolveAuthScopedUserId`
  - `resolveRealtimeActorId`
  - `isRealtimeKeySegment`
  - `toRealtimeKeySegment`

Offline login:

- `services/offlineLoginResolver.js` permits re-entry only for cached sessions or cached Tour Packs.
- Unknown first-time users are blocked offline with explicit reason codes.
- Passenger offline login requires normalized email match.
- Passenger session/Tour Pack restores recursively apply the server-safe passenger allowlist and atomically replace valid legacy caches; an unprojectable cache requires an online refresh.
- Offline cache TTL is 30 days.

---

## 6. Core Data Contracts

### Tour Identity

Source doc: `docs/data-contracts/tour-identity.md`

- Web-admin-created `tours/{tourId}` keys are generated from `tourCode`.
- Example: `tourCode = "5112D 8"` -> `tourId = "5112D_8"`.
- `tourCode` is immutable after creation.
- Creating a tour must use a transaction that commits only when
  `tours/{generateTourId(tourCode)}` is absent, preventing concurrent duplicate
  creates from overwriting an existing tour.
- Duplicate/copy flows must generate a fresh tour code before writing.
- Duplicate/copy flows use an explicit definition-field allowlist and never copy live participants, safety, tracking, counts, or assignments.
- Do not let `tourCode` and the Firebase key drift. Mobile often derives IDs from tour codes.
- Renaming a tour code requires deliberate multi-root migration across tours, manifests, bookings, assignments, chats, photos, and caches.
- `tours/{tourId}/currentParticipants` is an admin-owned operational count. Passenger login/join may use membership size only as a read-only fallback and must not rewrite the booked/admin total.

### Driver Assignment

Source doc: `docs/data-contracts/driver-assignment.md`

Canonical active assignment key:

- `drivers/{driverId}/currentTourId`

Canonical nodes to keep coherent in one multi-path update:

- `drivers/{driverId}`
- `tours/{tourId}/driverId` plus `driverName` and `driverPhone`
- `tour_manifests/{tourId}/assigned_drivers/{driverId}`
- `tour_manifests/{tourId}/assigned_driver_codes/{driverId}`
- `users/{authUid}/driverId`
- `users/{authUid}/driverPrincipalId`
- `users/{authUid}/driverAssignedTourId`
- `users/{authUid}/principalType`

Canonical `assigned_driver_codes/{driverId}` payload:

```ts
{
  driverId: string,
  tourId: string,
  tourCode: string,
  assignedAt: string,
  assignedBy: string
}
```

Producers:

- Backend: `functions/index.js` (`assignDriverToTour`); mobile invokes it from
  `services/bookingServiceRealtime.js`
- Web admin: `web-admin/src/services/tourService.js` (`buildDriverAssignmentUpdates`, `applyDriverAssignmentMutation`)

Rules authorize assigned driver manifest writes only when:

- `users/{authUid}/driverId` points to the driver.
- `drivers/{driverId}/authUid` matches the caller.
- `tour_manifests/{tourId}/assigned_drivers/{driverId}` is `true`.
- The booking belongs to the tour by canonical `bookings/{bookingRef}/tourId`.

### Manifest Sync

Source doc: `docs/data-contracts/operational-update-integrity.md`

- Manifest updates live under `tour_manifests/{tourId}/bookings/{bookingRef}`.
- Status values: `PENDING`, `BOARDED`, `NO_SHOW`, `PARTIAL`.
- `passengerStatus` is an array-like child collection of per-passenger statuses.
- Manifest writes use an RTDB transaction; conflict policy compares local/server `lastUpdated` inside that transaction.
- Newer server value wins. The service returns the exact preserved status, passenger statuses, and timestamp for operator feedback.
- Offline manifest updates queue through `offlineSyncService` as `MANIFEST_UPDATE`.
- Identity-scoped Tour Packs are the only offline source for driver itineraries. Delete legacy `driver_itinerary_{tourId}` entries without displaying or migrating their unscoped contents.
- A newer queued update supersedes an older non-syncing update only for the same canonical tour and booking.
- Manifest queue badges, counts, failed retries, and conflict results must be scoped to the active tour.

### Itinerary Reliability

- `getTourItinerary` reads only `tours/{tourId}/itinerary`; an absent snapshot returns `null`, while a failed read throws so callers never erase a valid Tour Pack as if the itinerary were deleted.
- Itinerary Tour Pack metadata uses `itineraryLastSyncedAt` and `itineraryRevision`; driver operational text uses `driverItineraryLastSyncedAt`. Metadata writes merge serially and keep the global `lastSyncedAt` monotonic.
- The client itinerary UI distinguishes `live`, `cache`, and `none`. Cached data must never be labelled live, and freshness must continue recalculating while the screen is open.
- Entering edit mode pauses realtime replacement. A conflict keeps the draft intact and disables publishing until the driver explicitly loads the server version or confirms their draft as the next base.
- `sendItineraryNotification` uses `onValueWritten` to cover first publication, meaningful updates, and withdrawal; metadata-only writes are silent.
- Legacy day `activities` remain accepted and are normalized to readable `content` at the mobile service boundary.

### Chat and Reactions

Source doc: `docs/reactions-write-contract.md`
Delivery source doc: `docs/data-contracts/chat-delivery.md`

Message roots:

- Group chat: `chats/{tourId}/messages`
- Internal driver chat: `internal_chats/{tourId}/messages`

Modern messages must include stable sender fields:

- `senderId`
- `senderStableId`
- `senderName`
- `text`
- `timestamp`

Version 2 messages also require `schemaVersion: 2`, `clientCreatedAt`, `senderType`, `status: sent`, `type`, and an `idempotencyKey` equal to the Firebase message key. Create them transactionally at that deterministic key; direct send, offline replay, and manual retry must never allocate different keys for one logical message.

Drivers may write as verified `driver:{DRIVER_ID}` principals.

Canonical reaction path:

```text
chats/{tourId}/messages/{messageId}/reactions/{emoji}/{actorKey} = true
```

Rules:

- Reaction writes are user-leaf only.
- Never write to `reactions`, `reactions/{emoji}`, or the message parent for reaction toggles.
- `typing`, `presence`, and `lastRead` actor keys must follow the same identity encoding rules.

Chat UX utilities:

- `utils/chatTimeline.js`
- `utils/chatUnreadSummary.js`
- `utils/chatReplyNavigation.js`
- `utils/chatSearch.js`
- `utils/chatRetry.js`
- `services/chatSwipeReplyGesture.js`

### Photos and Variants

Source doc: `docs/photo-upload-variant-contract.md`

Photo roots:

- Group metadata: `group_tour_photos/{tourId}/{photoId}`
- Private metadata: `private_tour_photos/{tourId}/{stablePassengerKey}/{photoId}`
- Group Storage source objects: `group_tour_photos/{tourId}/{filename}`
- Private Storage source objects: `private_tour_photos/{tourId}/{ownerKey}/{filename}`
- Server variants are written under `thumbnails/` and `viewers/` subfolders.

Current upload contract:

- Queue action type: `PHOTO_UPLOAD`
- `payloadVersion: 2`
- New idempotent uploads use a deterministic Realtime Database record key; legacy push-key records remain discoverable through an indexed exact `idempotencyKey` query.
- Source-only durable payload:
  - `idempotencyKey`
  - `localAssets.sourceUri`
  - optional `localAssets.previewUri`
  - optional `metadata.caption`
- Replay must call `photoService.uploadPhotoDirect(...)`.
- Screen components should not bypass the service to do network upload replay.

DB lifecycle fields for new uploads:

- `variantStatus: "processing"`
- `storagePath` for both group and private photos; neither scope persists durable media URLs
- `variantUpdatedAt`
- `variantError`
- `variantVersion: 2`

Server variant generator:

- Function: `generatePhotoVariants`
- Region: `us-east1`
- Uses `sharp` to create viewer and thumbnail JPEGs.
- Group and private records become ready with path fields only and resolve five-minute signed URLs in memory;
  their source/variant objects must not retain Firebase download tokens. Failed generation stores
  `variantStatus: "failed"` with `variantError`.

Storage rules:

- Direct client Storage access to `group_tour_photos/**` is denied. `resolveGroupPhotoMedia`,
  `uploadGroupPhoto`, `deleteGroupPhoto`, and `createGroupPhotoChatMessage` require Auth plus App
  Check and re-check current participant or coherent assigned-driver access on every request.
- Group chat image records store `photoId`, never durable `imageUrl` or `thumbnailUrl` fields.
- Group uploads are server-owned, deterministic/idempotent, supported-image-only, and capped at 10 MB.
- Group URL/token cleanup is exact-tour and dry-run first. Back up both `group_tour_photos` and
  `chats`, inventory every tour present in either branch, deploy the server Functions and deny-direct
  Storage rules, then run `npm --prefix functions run harden:group-photos -- --apply --tourId=TOUR_ID`.
  The migration revokes unreferenced object tokens, handles `sourceUrl`/`url`/`fullUrl` history,
  converts chat URLs to `photoId`, recovers existing chat-only objects, and clears links to missing
  objects. Continue with `--after=NEXT_CURSOR` when returned.
- Max image size is 10 MB.
- Private object access requires the signed `privatePhotoOwnerKey` Auth claim created by the
  passenger login verifier; the client force-refreshes its ID token after verification.
- Private RTDB records are path-authoritative and never persist durable download-token URLs. Mobile
  resolves batches of at most 50 private records through `resolvePrivatePhotoMedia`; returned
  five-minute signed URLs are memory-only.
- Object custom metadata must not contain stable passenger IDs, booking-derived owner keys, tour
  IDs, idempotency keys, or upload timestamps.

Expo FileSystem contract:

- Files using old FileSystem APIs must import `expo-file-system/legacy`.
- Static tests enforce this for `ImageViewer`, `PhotobookScreen`, `imageOptimizationService`, and `photoViewerCacheService`.

### Offline Tour Pack and Sync

Source doc: `docs/offline-tour-pack.md`

Service:

- `services/offlineSyncService.js`

Persistence:

- `services/persistenceProvider.js`
- Operational queues and Tour Packs require durable AsyncStorage. They may migrate legacy SecureStore values but must never silently fall back to process memory.
- Partial Tour Pack writes are serialized per tour/role/login identity before read-merge-write; parallel screen caches must not clobber one another or cross a shared-device login boundary.
- Passenger itinerary is stored as `itinerary`; driver operational text is stored as `driverItinerary` in the driver Tour Pack. The old `driver_itinerary_<tourId>` AsyncStorage key is migration-only.
- SecureStore remains appropriate only for small secret/session material explicitly configured for it.
- Browser AsyncStorage is durable through its localStorage-backed adapter.
- Test env defaults to memory unless an adapter is injected.

Queue safety:

- The sync queue is capped at 500 actions and must preserve the existing queue when a storage read fails.
- Every action is owned by a canonical tour/principal/role scope. Replay, mutation, retry, counts, and subscriptions must never expose or process another session's actions.
- Corrupt queue payloads are backed up before reset.
- The safety retry queue is capped at 250 events, prioritises critical/SOS events, and is principal scoped. Trusted contacts are stored per principal.

Tour Pack keys:

- `tour_pack_v2_<role>_<tourId>_<encodedBookingOrDriverId>`
- `tour_pack_meta_v2_<role>_<tourId>_<encodedBookingOrDriverId>`
- `queue_v1`
- `processed_action_ids_v1`

Queue action types:

- `MANIFEST_UPDATE`
- `CHAT_MESSAGE`
- `INTERNAL_CHAT_MESSAGE`
- `PHOTO_UPLOAD`

Replay policy:

- FIFO by `createdAt`.
- Single in-process replay lock.
- Max attempts: 5.
- Processed action IDs persisted to avoid duplicate replay.
- Failed and retrying actions remain retryable.
- Completed `PHOTO_UPLOAD` actions are pruned by TTL while preserving recent completed items.

The existing identity-scoped device Tour Pack cache is separate from the new server-owned Driver
Tour Pack source. `driverTourPackService` owns the server-projected, auth UID + driver ID +
departure-key scoped cache; it never merges with the existing screen cache. `useDriverTourPack`
shows valid cache first, subscribes only to the exact assigned pack revision, fetches full content
only when the semantic revision changes, and validates the complete payload before atomic
replacement. Failed/malformed responses preserve valid cache; expired/withdrawn packs purge PII.

`driverManifestCacheService` separately stores only explicit, complete v1 `getTourManifest`
responses so a driver can cold-start the full boarding manifest offline. `tour_manifests` remains
authoritative and queued updates patch the device snapshot only after durable enqueue.

Logout, driver identity change, reassignment, assignment validation failure, cancellation/withdrawal,
and expiry must call the exact-scope lifecycle purge. It stops old replay, removes both Tour Pack
caches, the complete manifest and that scope's actions, and uses generation guards so late old-tour
responses cannot repopulate storage. Driver Tour Pack remote reads capture the cache generation before
network I/O; purge increments that generation under the same per-scope lock before deleting, and a late
replacement must fail closed when its captured generation no longer matches.

Canonical sync states:

- `OFFLINE_NO_NETWORK`
- `ONLINE_BACKEND_DEGRADED`
- `ONLINE_BACKLOG_PENDING`
- `ONLINE_HEALTHY`

Shared metadata lives in:

- Mobile: `utils/unifiedSyncContract.js`
- Web admin copy: `web-admin/src/services/unifiedSyncContract.js`

Canonical manual refresh text:

```text
{X} synced / {Y} pending / {Z} failed
```

Use `buildSyncSummary`, `formatSyncOutcome`, and `deriveUnifiedSyncStatus`. Do not invent per-screen sync wording.

### Dates and Time

Source docs:

- `docs/date-contract.md`
- `docs/date-contract-web-admin.md`

Date-only accepted inputs:

- UK: `dd/MM/yyyy`
- ISO: `yyyy-MM-dd`

Timestamp accepted inputs:

- Epoch milliseconds as number or numeric string.
- ISO-8601 datetime with timezone.

Mandatory rules:

- Never use `new Date(unvalidatedString)` on payload dates.
- Never use `Date.parse(...)` outside strict utility gates.
- Tour start/end dates persist as UK `dd/MM/yyyy`.
- HTML date inputs use ISO and must convert through strict helpers.

Key helpers:

- Mobile: `services/itineraryDateParser.js`, `services/pickupTimeParser.js`, `services/timeUtils.js`
- Web admin: `web-admin/src/utils/dateUtils.js`, `web-admin/src/utils/triageUtils.js`

### Notifications

Source doc: `docs/data-contracts/operational-update-integrity.md`

Mobile service:

- `services/notificationService.js`
- `services/notificationInboxService.js`
- `utils/notificationRouting.js`

Durable tour update roots:

```text
tour_notifications/{tourId}/{noticeId}
notification_read_state/{tourId}/{canonicalPrincipalKey}/{noticeId}
```

- Functions own notice creation; mobile clients cannot forge notices.
- Tour members and verified assigned drivers can read only their attached tour feed.
- Tour feed/read-state access and operational fanout require a current non-expired app session; stale membership, stale assignment, or an active token alone is insufficient.
- Passengers write read timestamps only below the stable principal key bound to their authenticated profile; verified drivers use `driver:{driverId}`. A UID branch is reserved for legacy participants without a stable binding.
- Read-state writes also require current tour membership/verified assignment and an existing notice. Notice eviction enqueues an exact server-private cleanup job; `cleanupNotificationReadState` drains at most 10 jobs in 50-user continuation pages every 15 minutes.
- A canonical-principal client submits an exact, identity-authorized `notification_read_migration_requests/{tourId}/{authUid}` record. Because UID-only history is ambiguous on shared devices, `processNotificationReadMigrationRequest` deletes (never copies) the legacy UID branch, removes the request, and writes a per-tour completion marker inside the authenticated user profile to suppress repeat work.
- The scheduled cleanup also seeds a server-private legacy-tour queue from a single shallow key discovery, then processes one queued tour in bounded 50-principal pages. It preserves canonical keys and live UID-only accounts, removes only obsolete bound-identity or deleted-auth UID branches, and removes the queue item when the tour is deleted or exhausted.
- Tour-scoped notification taps are accepted only for the active canonical tour. Global marketing taps may open `NotificationPreferences` after an app session is restored, even when no tour is active.
- Push payloads and durable notices preserve `noticeId` plus destination context such as `messageId`, `categoryKey`, and `broadcastId`. Chat opens the exact message, including an on-demand lookup when it is outside the live 80-message window.
- Cold/foreground responses are deduplicated only after navigation succeeds; concurrent delivery is suppressed while a response is in flight and a failed navigation remains retryable.
- The tour feed is capped server-side at the newest 100 notices and queried client-side at the newest 50.
- Read-state listeners are capped at the newest 100 numeric timestamps. The mobile feed keeps a minimal versioned 30-day auth-UID/canonical-principal/tour cache, preserves it on listener failure with explicit retry/stale UI, and revokes then purges every indexed cache for that UID on logout/account deletion. A persisted generation marker prevents a late listener write or orphaned cache/index entry from becoming readable after revocation.
- Category-broadcast routes require a supported canonical category plus broadcast ID. Preference load work runs in parallel, and one resolved permission decision is reused through token registration/save.

User profile fields:

- `pushToken`
- `pushTokenStatus`: `ACTIVE`, `INVALID`, `UNAVAILABLE`
- `pushTokenProvider`
- `pushTokenUpdatedAt`
- `pushTokenInvalidReason`
- `pushPermissionState`: `granted`, `denied`, `blocked`, `unavailable`
- `pushPermissionCanAskAgain`
- `pushPermissionUpdatedAt`
- app/device metadata: `deviceOS`, `deviceModel`, `appVersion`, `appBuild`, `osVersion`

Preference schema:

```text
users/{uid}/preferences/ops/driver_updates
users/{uid}/preferences/ops/itinerary_changes
users/{uid}/preferences/ops/group_chat
users/{uid}/preferences/ops/group_photos
users/{uid}/preferences/marketing/*
```

Function fanout safeguards:

- deterministic chunking
- active app-session and matching participant/driver-assignment eligibility
- recipient cap: 1000
- user fetch chunk size: 100
- recipient chunk size: 200
- token invalidation cleanup only if the stored token still matches the failed token
- preference-aware routing

### Operations Alerts

Source doc: `docs/data-contracts/ops-alerts.md`

Curated operational alert root:

```text
ops_alerts/{fingerprint}
```

Purpose:

- Web-admin live Operations / Health / Errors surface for major mobile device/app failures.
- Raw diagnostics stay under `logs/{userKey}/{sessionKey}` and crash snapshots stay under `logs/{userKey}/{sessionKey}/crashDiagnostics`.
- The browser dashboard must subscribe to bounded `ops_alerts` queries, not the whole `/logs` tree.

Record requirements:

- Required compact fields include `createdAt`, `createdAtMs`, `severity`, `level`, `source`, `component`, `message`, `status`, `userKey`, `sessionKey`, `deviceInfo`, `fingerprint`, `count`, `lastSeenAtMs`, and `summary`.
- Optional safe context includes `tourId`, `role`, `appContext`, and `crashBreadcrumbSummary`.
- Never store booking refs, emails, raw auth UIDs, raw session IDs, driver codes, tokens, push tokens, passwords, authorization values, or raw stack data.

Producers:

- `services/loggerService.js` creates/updates alerts for uploaded `ERROR` and `FATAL` logs.
- `services/crashDiagnosticsService.js` creates/updates alerts for global error crash snapshots.
- Pure sanitisation/fingerprinting helpers live in `services/opsAlertService.js`.

Web admin:

- Service helpers live in `web-admin/src/services/opsAlertService.js`.
- Admins can acknowledge/resolve alerts through web-admin.

### Safety and Location

Safety delivery source contract: `docs/data-contracts/safety-delivery.md`.

Safety service:

- `services/safetyService.js`

Safety roots:

- `tours/{tourId}/safetyAlerts`
- `tours/{tourId}/liveTracking`
- `globalSafetyAlerts`
- safety-related entries under `logs/{userKey}/safety`

Safety report creation uses one idempotent root multi-path update across the
private log, tour alert, and (for SOS/critical events) global alert. Do not
return a submitted result or remove an offline retry item after only the private
log succeeds; operations-visible delivery is part of the contract.

New clients submit through the authenticated `submitSafetyReport` Function. The
client event ID is stable across timeout/offline replay, the Function verifies
tour/role membership and serializes that ID, and an already-written matching
event is an idempotent success. `sendSafetyAlertNotification` fans out
privacy-preserving operational alerts to assigned drivers and eligible admin
mobile profiles without including free-text incident details on the lock screen.

Driver location:

- Canonical passenger/driver live bus path: `tours/{tourId}/driverLocation`.
- Source contract: `docs/data-contracts/driver-location.md`.
- Versioned records use a server timestamp and distinguish fixed `pickup` points from foreground `live` sharing.
- Driver Home writes manual and auto-share location updates through `services/driverLocationService.js`; each foreground auto-share lifecycle owns an opaque session, preserves any validated fixed pickup fallback, arms Firebase disconnect removal/restoration, and transactionally withdraws only its exact live state on disable/background/reassignment/unmount.
- Auto locations carry a server-validated `cleanupAtMs` lease. `cleanupExpiredDriverLocations` runs every 15 minutes, queries the indexed lease in bounded batches, and compare-deletes only the exact expired session.
- Map and Tour Home derive presentation through `utils/driverLocation.js`. Live points cover the three-minute cadence, become non-actionable when stale or worse than 500m accuracy, and disappear after 30 minutes; manual pickup points remain destinations without a live label.
- Find My Bus derives connection truth from Firebase `.info/connected`, retries subscription failures explicitly, and haptics only on a changed publication after the initial snapshot.
- Find My Bus does not require passenger location permission to show the driver point. Permission is requested only when the passenger chooses to show/refresh their own position.
- Driver reassignment/unassignment clears the former tour's location atomically so passengers never inherit another driver's coordinates.
- Auto-share checks lifecycle cancellation after native location capture and after the service write. Logout, backgrounding, reassignment, disable, or unmount must revoke the exact session so late coordinates never return to the former tour.

Safety UX:

- `SafetySupportScreen` handles emergency options, trusted contacts, offline safety queue, and optional location sharing.
- The app opens emergency options and does not call 999 automatically.
- UI must distinguish a remotely submitted report from one durably saved for retry; it must never claim an event was queued when persistence failed.

---

## 7. Mobile Service Layer

High-signal services:

- `bookingServiceRealtime.js`
  - passenger verifier integration
  - driver login and assignment
  - manifest fetch/update
  - participant join transaction
  - itinerary fetch
- `offlineSyncService.js`
  - Tour Pack cache
  - offline queue
  - replay, retry, sync summary, staleness labels
- `chatService.js`
  - group/internal chat send/subscribe
  - reactions, typing, presence, read receipts
  - bounded pagination
- `photoService.js`
  - upload, direct replay upload, pagination, subscriptions
  - delete and caption update
  - group/private owner scoping
- `photoVariantService.js`
  - display URL resolution and cache key derivation
- `imageOptimizationService.js`
  - source upload optimization
- `notificationService.js`
  - Expo push token registration
  - preference normalization and user profile metadata
- `identityService.js`
  - principal and RTDB key helpers
- `loggerService.js`
  - safe logging, redaction, local/server log queue
- `crashDiagnosticsService.js`
  - breadcrumbs and crash diagnostics under `logs`
- `safetyService.js`
  - safety events, live tracking, trusted contacts, offline safety queue
- `optionalServiceLoader.js`
  - safe optional requires for test/runtime boundaries
- `appMetadata.js`
  - app version/build/OS metadata for profile writes

Most service functions return `{ success: true|false, data|error }`. Preserve that shape unless the existing function clearly throws by contract.

---

## 8. Web Admin Surface

Location: `web-admin/`

Main services/utilities:

- `src/services/dashboardService.js`
  - live dashboard subscriptions
  - dispatch, passenger load, safety, broadcast, and component alert derived metrics
  - sanitised summaries for dashboard display
- `src/services/tourService.js`
  - tour CRUD
  - templates
  - driver assignment multi-path updates
  - CSV import/export preview and execution
  - immutable tour identity guards
- `src/services/passengerService.js`
  - validated manual passenger booking creation through the `createManualPassengerBooking` Cloud Function
- `src/services/tourCsvService.js`
  - CSV parser and row validation
- `src/services/healthService.js`
  - dashboard health snapshot mapped to shared sync state taxonomy
- `src/services/unifiedSyncContract.js`
  - web-admin copy of canonical sync metadata
- `src/utils/dateUtils.js`
  - strict date/timestamp parsing and formatting
- `src/utils/triageUtils.js`
  - date-based dashboard urgency metadata

Operational expectations:

- Dashboard metrics, panels, badges, buttons, filters, links, and status indicators must be backed by live Firebase data or deterministic helper-derived values. Remove fake trends and dead controls instead of displaying placeholders.
- Dashboard app/device failures must come from bounded `ops_alerts` queries, never `/logs`.
- Dashboard safety rows must display only sanitised summaries and must not expose booking refs, emails, auth UIDs, raw user/session IDs, tokens, push tokens, raw coordinates, or secrets.
- Dashboard tour deep links use `/tours?q={tourId}`; unassigned queue links use `/tours?status=unassigned`.
- Tours status filter and URL query param stay synchronized.
- Tours search query param `q` stays synchronized with the search field for dashboard deep links.
- Choosing "All Tours" removes the `status` query param.
- Dashboard deep links use `/tours?status=unassigned`.
- Tour identity guards reject create/update flows that would overwrite or mutate a generated tour key.
- Tour updates perform one authoritative read, reject a missing target, and
  validate partial date/capacity patches against the stored tour before writing.
- Dated tours persist canonical UTC-midnight `startDateEpochMs` and `endDateEpochMs` query fields;
  date-leaf Functions normalize them for every producer without firing on unrelated tour children.
  `ToursManager` subscribes through the indexed `endDateEpochMs` window with a 500-record cap,
  discloses capped totals/exports, and fetches exact dashboard deep-link IDs on demand. Run the
  dry-run-first `backfill:tour-date-indexes` maintenance command before releasing this query path
  over legacy records.
- `normalizeTourDateIndexes` and `normalizeTourEndDateIndex` repair those fields after writes to the
  `startDate` and `endDate` leaves, including external management/Apps Script and Admin SDK producers,
  without firing for unrelated tour updates. Release order is Functions, verified backfill, RTDB
  index/validation rules, then the bounded web-admin query. The Functions remain authoritative because
  parent admin writes and Admin SDK producers cannot be made field-required at child rules.
- Tours and Drivers share the bounded driver-directory subscription. Driver Tour Pack coverage and
  operations are derived only for visible tours using prebuilt assignment/issue indexes; issue
  queries are exact-departure scoped and capped rather than downloading the global issue history.
- Driver issue operations projections use a base64url composite departure/driver/issue key so reused
  `issue_001` identifiers never collide. `departurePriorityKey` orders unresolved critical issues first
  and newest within priority. Run `backfill:driver-tour-pack-issues` before releasing the matching web query;
  delete legacy issueId-only projections only when their embedded source identity matches.
- Driver assignment writes must align with the mobile canonical `currentTourId` contract and clean stale assignment links.
- Driver creation must use a transaction and fail on an existing driver code; never replace a driver record during create.
- CSV updates are field-preserving patches. Missing columns must not clear itinerary, pickup, assignment, or other state; driver assignment requires a canonical existing Driver ID.
- Destructive tour and reported-photo actions must use authenticated Functions so RTDB and Storage cleanup is coordinated.
- Broadcast UI must say queued until Functions publish a terminal delivery status; Expo acceptance is not a device-display receipt.
- Manual passenger creation must go through `createManualPassengerBooking`; do not write `bookings`, `booking_identities`, and manifest rows directly from the browser.
- User-facing errors should be sanitized, especially auth and password reset errors.
- Vite dev server adds basic security headers in `vite.config.js`; keep preview/deploy parity in mind.

---

## 9. Cloud Functions

Location: `functions/index.js`

Runtime: Node.js 22. Firebase deployment runtime must stay on a currently supported Functions runtime.

Exported functions:

- `verifyPassengerLogin`
  - HTTPS `POST`
  - region `europe-west1`
  - validates credentials from `booking_identities/{bookingRef}`, then creates/reuses and device-binds the principal in server-only `passenger_identity_security/{bookingRef}`
  - Firebase Auth, explicit optional App Check mode, and a fail-closed missing-configuration guard
  - distributed atomic rate limits in separate opaque credential-, account-, and broad network-level buckets after authentication
- `verifyDriverLogin`
  - HTTPS `POST`, authenticated, region `europe-west1`
  - validates driver credentials and the configured App Check mode, then transactionally binds an
    unclaimed driver record to the caller and persists server-owned identity helpers
  - rate limited in separate credential-, account-, and broad network-level buckets
- `cleanupExpiredLoginRateLimits`
  - scheduled hourly in `europe-west1`
  - deletes expired opaque limiter records in bounded batches; no raw account, credential, UID,
    email, driver code, client ID, user agent, or IP values are stored
- `assignDriverToTour`
  - HTTPS `POST`, authenticated driver-only, region `europe-west1`
  - serializes competing driver/tour mutations, rejects occupied or inactive tours, and
    atomically updates the canonical driver, tour, manifest, and user-profile links
- `createManualPassengerBooking`
  - HTTPS `POST`
  - region `europe-west1`
  - admin-only through the hardcoded admin UID or `admin_users`
  - validates tour identity, booking reference, login email, pickup fields, passenger rows, and seat collisions
  - atomically writes `bookings`, `booking_identities`, `tour_manifests`, pickup indexes, and tour passenger counts
- `deleteTourData`
  - HTTPS `POST`, authenticated admin-only, region `europe-west1`
  - removes all tour-owned RTDB branches, booking identities/grants, canonical driver links, and group/private Storage prefixes
  - remains idempotent after the primary tour node is gone; retries repeat
    deterministic cleanup and return `alreadyDeleted: true`
- `removeReportedPhoto`
  - HTTPS `POST`, authenticated admin-only, region `europe-west1`
  - deletes source/viewer/thumbnail Storage objects before atomically removing metadata and actioning the report
- Admin HTTPS Functions accept browser CORS requests only from the deployed
  `web.app`/`firebaseapp.com` portal origins or localhost development. Additional
  custom admin domains require an exact comma-separated
  `ADMIN_PORTAL_ALLOWED_ORIGINS` environment value; bearer authentication and
  the operations-admin check remain mandatory.
- `processBroadcastWrite`
  - RTDB create trigger on `/broadcasts/{tourId}/{broadcastId}`
  - region `europe-west1`
  - validates admin author and writes `ADMIN_BROADCAST` chat message
  - persists queued/processing and terminal delivery status on the broadcast record
- `sendChatNotification`
  - RTDB create trigger on `/chats/{tourId}/messages/{messageId}`
  - region `europe-west1`
  - validates sender/participant/assigned-driver/admin broadcast authenticity
  - sends to participants plus coherently assigned driver auth users
  - routes by `preferences.ops.group_chat` or `preferences.ops.driver_updates`
  - writes eligible/accepted/failed counts back for admin broadcasts
- `sendInternalChatNotification`
  - RTDB create trigger on `/internal_chats/{tourId}/messages/{messageId}`
  - notifies the other coherently assigned drivers
  - routes to the exact internal-driver chat message
- `cleanupNotificationReadState`
  - scheduled every 15 minutes in `europe-west1`
  - drains durable read-state cleanup jobs in bounded 10-job / 50-user continuation pages
  - performs one shallow legacy-tour key discovery, then drains the private tour queue with bounded 50-principal RTDB queries and Firebase Auth existence checks
- `processNotificationReadMigrationRequest`
  - retry-enabled RTDB create trigger on `/notification_read_migration_requests/{tourId}/{authUid}` in `europe-west1`
  - validates the requested key against the server-side passenger/driver profile, deletes ambiguous legacy UID read markers without attribution, and records completion on the user profile
- `generatePhotoVariants`
  - Storage finalize trigger
  - region `us-east1`
  - creates server-owned viewer/thumbnail variants and updates photo metadata
- `sendItineraryNotification`
  - RTDB update trigger on `/tours/{tourId}/itinerary`
  - region `europe-west1`
  - sends to tour participants plus assigned driver auth users
- `normalizeTourDateIndexes`
  - RTDB write trigger on `/tours/{tourId}/startDate`, region `europe-west1`
  - repairs or removes derived UTC date-query fields after start-date writes from every producer
- `normalizeTourEndDateIndex`
  - RTDB write trigger on `/tours/{tourId}/endDate`, region `europe-west1`
  - repairs or removes derived UTC date-query fields after end-date writes from every producer
- `submitSafetyReport`
  - authenticated HTTPS `POST`, region `europe-west1`
  - validates caller tour/role access and bounded report/location input
  - atomically writes private, tour, critical-global, and idempotency-lock paths
- `endAppSession`
  - authenticated and active-session-protected HTTPS `POST`, region `europe-west1`, CORS disabled
  - compare-ends only the exact expected session and removes session-derived authority and ephemeral state
- `revokeAppSession`
  - operations-admin HTTPS `POST`, region `europe-west1`, allowlisted reasons and optional expected-session compare
  - uses the same lock and cleanup path as normal logout without unassigning drivers or rotating passenger identity
- `cleanupExpiredAppSessions`
  - scheduled every 15 minutes in `europe-west1`
  - cleans at most 50 expired sessions and 100 expired bounded audit events per run
- `sendSafetyAlertNotification`
  - RTDB create trigger on `/tours/{tourId}/safetyAlerts/{eventId}`
  - alerts coherently assigned drivers and eligible operations-admin mobile profiles
  - stores Expo acceptance counts without exposing sensitive report text in push copy
- `ingestDriverTourPacks`
  - private HTTPS `POST`, region `europe-west1`, CORS disabled
  - Cloud Run IAM and in-process Google OIDC restrict the exact management sync service account
  - validates bounded versioned packs and semantic fingerprints before staging
  - uses begin/upload/finalize so partial or stale runs cannot become current
  - writes only `driver_tour_packs`, `driver_tour_pack_tombstones`, `driver_tour_pack_ingestion`, and PII-free Tour Pack operations projections
  - records only identities, counts, hashes, and reason codes in logs and audit metadata

Testing hook:

- `exports.__testables` exposes pure helpers for Node tests.

Maintenance scripts:

- `npm --prefix functions run backfill:photo-variants -- --dry-run --limit=50`
- `npm --prefix functions run migrate:app-sessions -- --project=loch-lomond-travel --limit=25`

Photo variant backfill example:

```bash
npm --prefix functions run backfill:photo-variants -- --dry-run --limit=50
npm --prefix functions run backfill:photo-variants -- --apply --tourId=5112D_8 --limit=50
```

Use `--visibility=group|private`, `--tourId=...`, and `--ownerKey=...` to narrow photo variant backfills.
Broad apply runs without `--tourId` require `--allow-full-scan`.
Before deploying derivative-path Storage rules, refresh each tour's ready group variants with
`--visibility=group --tourId=... --refresh-group-ownership=true`; continue bounded pages with the
returned `--after=NEXT_CURSOR`. This preserves the uploader `authUid` on server variants so owner
deletion remains functional while client variant creation/overwrite is denied.

Admin scaling migrations:

```bash
npm --prefix functions run backfill:tour-date-indexes
npm --prefix functions run backfill:tour-date-indexes -- --apply --allow-full-scan
npm --prefix functions run backfill:driver-tour-pack-issues
npm --prefix functions run backfill:driver-tour-pack-issues -- --apply --allow-full-scan
```

Legacy private URL/token hardening is dry-run first:

```bash
npm --prefix functions run harden:private-photos -- --dry-run --tourId=5112D_8 --ownerKey=OWNER_KEY --limit=50
npm --prefix functions run harden:private-photos -- --apply --tourId=5112D_8 --ownerKey=OWNER_KEY --limit=50
```

This migration has no broad-scan mode. Continue owner-scoped pages with `--after=NEXT_CURSOR` when
the prior result returns a cursor; missing Storage objects are retry-safe, while other errors fail closed.

---

## 10. Security Rules and Access

Sources:

- `database.rules.json`
- `storage_rules.json`

Important RTDB invariants:

- Root read/write are denied by default.
- Gate 6 permits only an exact `driver_tour_packs/{departureKey}` leaf read when all three facts
  agree: `users/{authUid}/driverId`, `drivers/{driverId}/authUid === authUid`, and
  `tour_manifests/{pack.tourId}/assigned_drivers/{driverId} === true`. Root/list reads, passenger,
  anonymous, stale, forged, and cross-tour reads remain denied; source-pack writes always remain
  denied. `driver_tour_pack_tombstones` and `driver_tour_pack_ingestion` stay server-private.
- `driver_tour_pack_actions/{departureKey}/{driverId}` is separate driver state. A client can
  access only its own leaf under the same coherent assignment and must satisfy the versioned,
  closed, bounded action schema. Gate 10 projects only safe progress counts/acknowledgement facts to
  `driver_tour_pack_progress/{departureKey}/{driverId}` and fixed-schema issues to
  `driver_tour_pack_issues/{issueId}`; never project passenger, pickup, hotel, supplier, free-text,
  or raw action payloads. Operations may update only issue status leaves through the approved action path.
- `cleanupExpiredDriverTourPacks` is a Gen 2 scheduled server cleanup. It deletes expired pack PII,
  driver actions, and metadata in batches of 50, leaving only a PII-free expiry tombstone. Deploy
  Functions first, then RTDB rules, then the mobile reader/cache release.
- `drivers`, `bookings`, `tours`, and `tour_manifests` must not expose collection-level authenticated reads.
- Passenger login uses `verifyPassengerLogin` to validate booking identity, return recursively allowlisted booking/tour projections, and create short-lived `tour_access_grants` / `booking_access_grants` before first purpose-specific child access. Passengers must never read whole `bookings/{bookingRef}` or `tours/{tourId}` records.
- Online passenger login must persist `users/{authUid}/bookingRef` before entering the app; that caller-owned profile link keeps exact manifest-row access working after short-lived grants expire.
- Driver-code login uses `verifyDriverLogin`; assignments resolve from `drivers/{driverId}/currentTourId`.
- Driver identity and assignment authority are server-owned. Claimed clients can update only
  `drivers/{driverId}/lastActive` and remove their own `authUid` during account deletion;
  they cannot self-assign through manifest or profile helper paths.
- Passenger manifest loading uses the `getTourManifest` HTTPS function; the mobile app must not scan `/bookings` to assemble manifests in production.
- Release order matters for backend access changes: deploy Functions first, then Realtime Database/Storage rules, then EAS update/build. Production binary EAS workflows test backend changes but do not deploy Firebase backend artifacts; the fast TestFlight OTA workflow assumes verification was completed before merge.
- `bookings/{bookingRef}` writes are admin-only.
- `tour_manifests/{tourId}/bookings/{bookingRef}` writes allow admin, verified assigned drivers, and passengers only for their own booking via `users/{authUid}/bookingRef` or a valid booking grant.
- `assigned_driver_codes` must use the canonical object payload.
- Chat message creates require ownership through auth UID, stable passenger identity binding, private owner identity, or verified driver principal.
- Chat reaction, typing, presence, and read-state actor leaves are identity-scoped.
- Private photos allow access by auth UID, raw stable identity, encoded stable key, raw private owner, encoded private owner key, or identity binding.
- Passenger profile creation and new `identity_bindings` writes must match the caller's canonical short-lived `booking_access_grants` identity; an authenticated client cannot self-assert an arbitrary passenger identity.
- `identity_bindings` and `identity_bindings_meta` are server/admin-owned; passenger clients cannot create, rotate, or delete bindings.
- `broadcasts` writes are admin-only and require numeric `createdAtMs`.
- `category_broadcasts` writes are admin-only, require numeric `createdAtMs`, and target canonical future-tour preference keys under `users/{uid}/preferences/marketing`.
- `users` validates push token metadata, identity metadata, driver helper fields, and notification preferences.
- Push tokens must use the bounded Expo token format; provider and app/device/permission metadata are value- and length-bounded.
- `admin_users` is the web-admin privilege allowlist; entries must be boolean `true`, and only the primary operations-admin UID may grant or revoke entries.
- `ops_alerts` reads are admin-only through the hardcoded admin UID or `admin_users`; mobile writes must be bounded, sanitised, fingerprinted, and schema-valid.
- `tours/{tourId}/safetyAlerts` and `globalSafetyAlerts` mobile writes are denied; authenticated
  clients submit through `submitSafetyReport`, while primary/delegated operations admins may
  update existing alert status and delivery fields.

Important Storage invariants:

- `group_tour_photos/{tourId}/...` read/write requires authenticated user and image constraints for writes.
- `private_tour_photos/{tourId}/{ownerKey}/...` read/write requires the caller's encoded stable/private owner key or identity binding.
- Private Storage ownership uses the verifier-issued `privatePhotoOwnerKey` custom claim because
  Storage rules cannot look up RTDB identity bindings directly.

If changing any protected data shape, update all of:

1. Service code
2. Security rules
3. Tests
4. Contract docs
5. This `AGENTS.md` when the operating model changes

---

## 11. Tests

Use incremental verification during implementation:

- After a known-green baseline, run only the test files or named suites affected by each subsequent change.
- Expand to adjacent contract, security-rule, or integration suites when a shared boundary changes; do not repeatedly rerun unrelated green suites.
- Before sign-off, deployment, or release, run one complete repository verification pass (including emulators when rules changed).
- If that final pass exposes a defect, fix it, rerun the affected slice first, then repeat the complete pass once the slice is green.

This keeps feedback fast without weakening the final release gate.

Root orchestration:

```bash
npm test
npm run test:all
npm run test:all:fast
npm run test:all:full
npm run test:all:with-emulators
npm run test:mobile:ota
```

Mobile suites:

```bash
npm run test:mobile
npm run test:mobile:auth
npm run test:mobile:sync:contract
npm run test:mobile:sync:engine
npm run test:mobile:services:booking
npm run test:mobile:services:chat
npm run test:mobile:services:photo
npm run test:mobile:services:notifications
npm run test:mobile:services:itinerary
npm run test:mobile:ui:date-time
npm run test:mobile:ux
npm run test:mobile:infra
```

Web admin:

```bash
npm run test:web-admin
npm --prefix web-admin run test
npm --prefix web-admin run test:all
```

Firebase emulator rules:

```bash
npm run test:emulators
```

Current `test:emulators` runs the complete Realtime Database and Storage rules matrix: app sessions, stale-session denial, reactions, manifests, photo variants, tours, drivers, account deletion, content reports, broadcasts, logs, notifications, safety alerts, and direct media denial. To isolate photo/session rules while diagnosing a failure, run:

```bash
firebase emulators:exec --project demo-llt-rules --only database "node --test tests/firebaseRules/photoVariants.rules.test.js"
```

All client Storage reads and writes under `group_tour_photos/**` and `private_tour_photos/**` are denied. Authenticated Functions verify the current app session for upload, short-lived URL resolution and deletion; App Check is explicitly disabled until provider registration is complete. RTDB metadata stores paths rather than durable download URLs.

High-value contract tests to know:

- `tests/uxAndBackend.contracts.test.js`
  - sync copy/taxonomy
  - principal-owned chat writes
  - identity binding meta least privilege
  - private photo access invariants
  - ops alerts rules/schema boundary
  - photo variant field allowance
  - stable identity key encoding
  - Expo FileSystem legacy import contract
- `tests/driverAssignmentContract.test.js`
- `tests/assignDriverToTour.cleanup.test.js`
- `web-admin/src/services/tourService.test.js`
- `web-admin/src/components/ToursManager.test.jsx`
- `web-admin/src/services/healthContractParity.test.js`
- `web-admin/src/services/opsAlertService.test.js`
- `web-admin/src/components/Dashboard.test.jsx`
- `tests/opsAlertService.test.js`
- `tests/functions.photoVariants.test.js`
- `tests/driverTourPackPublisher.test.js`
- `tests/driverTourPackBoundary.contract.test.js`
- `tests/driverTourPackCommandCentre.test.js`
- `tests/DriverTourPackScreen.behavior.test.js`
- `web-admin/src/services/driverTourPackAdminStatusService.test.js`
- `tests/firebaseRules/driverTourPacks.rules.test.js`
- `tests/stableIdentity.integration.test.js`
- `tests/validateBookingReference.passengerVerifier.test.js`
- `tests/offlineSyncService.test.js` and `__tests__/offlineSyncService.test.js`

Many root npm scripts use POSIX-style `NODE_ENV=test`. CI runs on Linux. On native Windows shells, use the same npm script first; if the shell rejects inline env assignment, run the underlying `node --test ...` command with `$env:NODE_ENV='test'` for local verification.

---

## 12. Build, Release, and Env

Mobile config:

- Use `app.config.js`; there is no static `app.json`.
- Version: `1.0.4`
- iOS build number: `3` local baseline; production increments are managed remotely by EAS
- Android version code: `3` local baseline; production increments are managed remotely by EAS
- Runtime version policy: `appVersion`
- EAS project ID: `1b1ae41f-9096-4e7d-887c-b617613cf603`
- Owner: `lochlomondtravel`

Root mobile commands:

```bash
npm start
npm run start:dev
npm run ios
npm run android
npm run web
```

EAS builds:

```bash
npm run build:dev:ios
npm run build:dev:android
npm run build:dev:ios-device
npm run build:preview
npm run build:production
```

Production EAS versioning:

- `eas.json` uses remote EAS app version management with `build.production.autoIncrement: true`.
- Production binary workflows must verify EAS remote version state before building; do not publish a store/TestFlight build if the remote counter cannot be read.
- Local `app.config.js` build numbers remain as the current native baseline for config inspection and first-time remote initialization, but production builds should let EAS increment the remote values.
- Current iOS submit profile stores only non-secret bundle metadata in `eas.json`; GitHub Actions injects App Store Connect IDs/API key material at runtime.
- Production config runs `plugins/withProductionReleaseCleanup.js` to remove Expo Dev Launcher local-network iOS metadata and Android overlay permission from store/TestFlight native config.
- The TestFlight workflow validates App Store Connect inputs before building, but only writes the `.p8` API key after the EAS build is complete so the key is never included in the build upload context.
- Driver Tour Pack v1.0.4 is compile-time TestFlight-eligible but still requires the independently revocable `driver_tour_pack_feature_flags/testflight` server flag; keep the production `global` flag false until the complete field-drill and release matrix has passed.
  Do not use a general production rollout, App Store submission, or broad OTA cohort as evidence for this
  operational feature.

OTA updates:

```bash
npm run update:dev
npm run update:testflight
npm run update:prod
```

Environment validation:

```bash
npm run validate:expo-env
npm run sync:eas-env:production
```

Root env facts:

- Mobile uses `EXPO_PUBLIC_*`.
- Web admin uses `VITE_*`.
- Android builds require `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY`.
- Production GitHub Actions validate `EXPO_PUBLIC_*` and sync them into EAS production before binary builds or TestFlight updates.
- Do not reintroduce unresolved `@secret` placeholder aliases in `eas.json`.
- Do not commit real `.env` files or service account files.

GitHub Actions:

- `.github/workflows/eas-build.yml`
  - manual production binary builds
  - verifies commit is on `main`
  - Node 24 plus Java 21 for Firebase emulators
  - installs root and Functions dependencies
  - runs mobile, Functions script, and Firebase rules tests
  - validates env and syncs EAS production env
- `.github/workflows/eas-update.yml`
  - iOS OTA update to the isolated `testflight` channel on `main` push or manual dispatch
  - verifies commit is on `main`
  - Node 24, root dependencies, iOS env validation and production EAS env sync
  - intentionally does not repeat the full test matrix; affected tests and one complete repository pass must be green before merge
  - never publishes the `production` channel; production OTA remains an explicit manual action
- `.github/workflows/eas-testflight.yml`
  - manual production iOS build followed by TestFlight submission
  - verifies commit is on `main`
  - runs the same mobile, Functions script, and Firebase rules tests as binary builds
  - validates/syncs production Expo env for iOS
  - requires `EXPO_ASC_APP_ID`; can use EAS-managed App Store Connect credentials or GitHub API-key secrets
  - optional manual inputs: TestFlight notes, internal TestFlight groups, and clear EAS build cache

Web admin:

```bash
cd web-admin
npm run dev
npm run build
npm run preview
```

Functions:

```powershell
cd functions
npm run serve
$env:FUNCTIONS_DISCOVERY_TIMEOUT='60'; npm run deploy  # PowerShell; large bundle discovery
npm run logs
```

---

## 13. Logging and Diagnostics

Source doc: `docs/safe-logging-conventions.md`

Use `services/loggerService.js` for mobile app logging:

- Prefer `logger.debug/info/warn/error/fatal` over direct `console.*` in app logic.
- Never log raw booking refs, driver codes, auth UIDs, stable passenger IDs, push tokens, passwords, session IDs, or authorization values.
- Use `maskIdentifier` and `redactSensitiveData`.
- Keep user-facing errors sanitized.

Diagnostics:

- `loggerService` persists a local queue and can upload to `logs/{userKey}/{sessionKey}`.
- `crashDiagnosticsService` writes crash diagnostics under `logs`.
- Safety events also write under `logs/{userKey}/safety`.
- Remote diagnostic and safety log writes require an authenticated identity; anonymous sessions stay local and must not write to `/logs`.
- `ops_alerts` is the sanitised, queryable operations layer for major device/app failures; do not put raw log payloads or raw stack data there.
- Production uploads are warning-plus by default; only change `EXPO_PUBLIC_REMOTE_LOG_MIN_LEVEL` as an explicit release decision.

---

## 14. Engineering Conventions

Follow existing patterns first:

- Reuse service helpers and contract utilities before adding abstractions.
- Keep service return shapes stable.
- Keep backend code Gen 2 and region-pinned.
- Keep driver/tour/manifest writes as atomic multi-path updates.
- Keep UX feedback non-blocking where established: banners, inline retry affordances, and refresh outcomes instead of blocking alerts.
- Use strict date/time helpers.
- Use identity helpers for RTDB key segments.
- Use `optionalServiceLoader` for optional dependencies where the repo already does.
- In photo code, preserve source-only `PHOTO_UPLOAD` v2 replay and server-owned variants.
- In chat code, keep subscriptions bounded and reaction writes leaf-only.
- In web-admin, keep status filters and URL query params synchronized.
- In web-admin operations health UI, subscribe to bounded `ops_alerts` queries rather than `/logs`.
- Avoid broad listener scopes; subscribe to current-tour branches and clean up on unmount.
- Do not rename core DB roots.
- Do not commit secrets.

When changing a data contract:

- Update service code.
- Update `database.rules.json` or `storage_rules.json`.
- Update targeted tests.
- Update the relevant doc under `docs/`.
- Update this file if future agents need to know the new contract.

---

## 15. Known Risks and Watch List

Date parsing drift:

- Locale parsing can break UK dates. Use strict helpers only.

Identity edge cases:

- Only `pax_v2_` opaque passenger IDs are valid. Treat any `pax_v1:` value as exposed credential material and fail closed.

Driver assignment coherence:

- `currentTourId` is canonical.
- Reassignment must clean stale manifest links in the same update.

Photo variant lifecycle:

- Client uploads source-only for v2; server variants may be processing or failed.
- UI must tolerate current photos while server variants are still processing.

Offline queue growth:

- Keep retry limits, processed ID trimming, and completed photo upload pruning.

Notification fanout scale:

- Preserve caps, chunking, cache TTLs, invalid token cleanup checks, and preference filtering.

Rules/code divergence:

- Schema changes without parallel rules/tests/docs updates are the highest-risk regressions.

Logging privacy:

- Lowering the remote log upload floor increases the blast radius of unsafe logging. Mask identifiers and keep verbose diagnostics temporary.
- `ops_alerts` is safe for admin viewing only because records are compact and sanitised; preserve that boundary.

Expo SDK compatibility:

- Legacy FileSystem API consumers must use `expo-file-system/legacy`.

---

## 16. Quick Reference

High-signal docs:

- `README.md`
- `docs/date-contract.md`
- `docs/date-contract-web-admin.md`
- `docs/data-contracts/driver-assignment.md`
- `docs/data-contracts/app-session.md`
- `docs/data-contracts/chat-delivery.md`
- `docs/data-contracts/driver-location.md`
- `docs/data-contracts/safety-delivery.md`
- `docs/data-contracts/manual-passenger-creation.md`
- `docs/data-contracts/passenger-data-boundary.md`
- `docs/data-contracts/ops-alerts.md`
- `docs/data-contracts/tour-identity.md`
- `docs/data-contracts/driver-tour-pack-ingestion.md`
- `docs/offline-tour-pack.md`
- `docs/app-session-rollout.md`
- `docs/app-session-operations-runbook.md`
- `docs/driver-command-centre-operations.md`
- `docs/photo-upload-variant-contract.md`
- `docs/reactions-write-contract.md`
- `docs/safe-logging-conventions.md`
- `docs/stable-identity-rollout-checklist.md`
- `docs/web-admin-live-operations-dashboard.md`
- `docs/firebase-cost-optimization-playbook.md`
- `docs/ux-improvement-task-backlog.md`

High-signal source:

- `App.js`
- `firebase.js`
- `services/bookingServiceRealtime.js`
- `services/offlineSyncService.js`
- `services/chatService.js`
- `services/photoService.js`
- `services/identityService.js`
- `services/notificationService.js`
- `services/opsAlertService.js`
- `services/safetyService.js`
- `utils/unifiedSyncContract.js`
- `database.rules.json`
- `storage_rules.json`
- `functions/index.js`
- `functions/lib/driverTourPackSchema.js`
- `functions/lib/driverTourPackPublisher.js`
- `functions/lib/managementOidc.js`
- `web-admin/src/services/dashboardService.js`
- `web-admin/src/services/tourService.js`
- `web-admin/src/services/healthService.js`
- `web-admin/src/services/opsAlertService.js`
- `web-admin/src/utils/dateUtils.js`

Common commands:

```bash
# mobile
npm start
npm run start:dev

# tests
npm test
npm run test:web-admin
npm run test:emulators

# web admin
cd web-admin
npm run dev

# functions
cd functions
npm run serve
```
