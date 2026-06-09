# Loch Lomond Travel (LLT) App - Agent Onboarding

Welcome, Agent. This file is the operational source of truth for contributors working in this repo. Keep it practical: update it whenever architecture, contracts, commands, or release assumptions materially change.

Last updated: May 28, 2026

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

- Expo SDK `55` (`expo ~55.0.0`)
- React Native `0.83.6`
- React `19.2.0`
- Firebase JS SDK `^12.14.0`
- `expo-notifications ~55.0.23`
- `expo-image ~55.0.11`
- `expo-image-manipulator ~55.0.17`
- `expo-file-system ~55.0.22`
- `expo-secure-store ~55.0.14`
- `@react-native-async-storage/async-storage 2.2.0`
- `react-native-maps 1.27.2`

Web admin:

- React `^19.2.0`
- Vite `^7.2.4`
- Mantine `^8.3.9`
- React Router `^7.13.0`
- Firebase JS SDK `^12.6.0`
- Vitest `^4.0.18`

Functions:

- Cloud Functions Gen 2 only
- Node runtime target `24`
- `firebase-functions ^7.1.1`
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
- `web_admin_settings`
- `booking_identities`

Admin UID hardcoded in rules:

```text
9CWQ4705gVRkfW5Xki5LyvrmVp23
```

Admin-only roots include protected writes such as `bookings`, `broadcasts`, `category_broadcasts`, `booking_identities`, and many privileged mutations. The web admin may let any Firebase email/password user sign in, but non-admin users should hit rules denials on protected operations.

Additional web-admin operators can be allowed through:

```text
admin_users/{authUid} = true
```

The hardcoded admin UID or an existing allowlisted admin can manage this allowlist. Do not use user-owned settings or profile fields as privilege signals.

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
- Client env flags:
  - `EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL`
  - `EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_TIMEOUT_MS`
  - `EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_USE_APPCHECK`
  - `EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_REQUIRE_APPCHECK`
- Backend App Check enforcement is controlled by `REQUIRE_APP_CHECK_FOR_LOGIN`.
- App Check is intentionally off by default in `.env.example`.

Driver login:

- Driver codes use `D-*` style identifiers.
- Driver login resolves driver profile, assignment context, and driver home tour context.
- Canonical driver principal for identity-sensitive paths is `driver:{DRIVER_ID}`.

Stable passenger identity:

- Canonical raw ID: `pax_v1:{BOOKING_REF}:{normalized_email}`.
- Raw stable IDs contain characters that are invalid in RTDB keys.
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
  - `identityVersion: "pax_v1"`
  - `normalizedPassengerEmail`

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
- Offline cache TTL is 30 days.

---

## 6. Core Data Contracts

### Tour Identity

Source doc: `docs/data-contracts/tour-identity.md`

- Web-admin-created `tours/{tourId}` keys are generated from `tourCode`.
- Example: `tourCode = "5112D 8"` -> `tourId = "5112D_8"`.
- `tourCode` is immutable after creation.
- Creating a tour must fail if `tours/{generateTourId(tourCode)}` already exists.
- Duplicate/copy flows must generate a fresh tour code before writing.
- Do not let `tourCode` and the Firebase key drift. Mobile often derives IDs from tour codes.
- Renaming a tour code requires deliberate multi-root migration across tours, manifests, bookings, assignments, chats, photos, and caches.

### Driver Assignment

Source doc: `docs/data-contracts/driver-assignment.md`

Canonical active assignment key:

- `drivers/{driverId}/currentTourId`

Canonical nodes to keep coherent in one multi-path update:

- `drivers/{driverId}`
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

- Mobile: `services/bookingServiceRealtime.js` (`assignDriverToTour`)
- Web admin: `web-admin/src/services/tourService.js` (`buildDriverAssignmentUpdates`, `applyDriverAssignmentMutation`)

Rules authorize assigned driver manifest writes only when:

- `users/{authUid}/driverId` points to the driver.
- `drivers/{driverId}/authUid` matches the caller.
- `tour_manifests/{tourId}/assigned_drivers/{driverId}` is `true`.
- The booking belongs to the tour by canonical `bookings/{bookingRef}/tourId`.

### Manifest Sync

- Manifest updates live under `tour_manifests/{tourId}/bookings/{bookingRef}`.
- Status values: `PENDING`, `BOARDED`, `NO_SHOW`, `PARTIAL`.
- `passengerStatus` is an array-like child collection of per-passenger statuses.
- Conflict policy compares local/server `lastUpdated`.
- Newer server value wins; server-win path reconciles local cache and user feedback.
- Offline manifest updates queue through `offlineSyncService` as `MANIFEST_UPDATE`.

### Chat and Reactions

Source doc: `docs/reactions-write-contract.md`

Message roots:

- Group chat: `chats/{tourId}/messages`
- Internal driver chat: `internal_chats/{tourId}/messages`

Modern messages must include stable sender fields:

- `senderId`
- `senderStableId`
- `senderName`
- `text`
- `timestamp`

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
- Source-only durable payload:
  - `idempotencyKey`
  - `localAssets.sourceUri`
  - optional `localAssets.previewUri`
  - optional `metadata.caption`
- Replay must call `photoService.uploadPhotoDirect(...)`.
- Screen components should not bypass the service to do network upload replay.

DB lifecycle fields for new uploads:

- `variantStatus: "processing"`
- `sourceUrl`
- `variantUpdatedAt`
- `variantError`
- `variantVersion: 2`

Server variant generator:

- Function: `generatePhotoVariants`
- Region: `us-east1`
- Uses `sharp` to create viewer and thumbnail JPEGs.
- Updates photo records to `variantStatus: "ready"` with `viewerUrl` and `thumbnailUrl`, or `variantStatus: "failed"` with `variantError`.

Storage rules:

- Authenticated image uploads only.
- Max image size is 10 MB.
- Private photo ownership is enforced in Realtime Database, not Storage rules.

Expo FileSystem contract:

- Files using old FileSystem APIs must import `expo-file-system/legacy`.
- Static tests enforce this for `ImageViewer`, `PhotobookScreen`, `imageOptimizationService`, and `photoViewerCacheService`.

### Offline Tour Pack and Sync

Source doc: `docs/offline-tour-pack.md`

Service:

- `services/offlineSyncService.js`

Persistence:

- `services/persistenceProvider.js`
- Storage order: SecureStore -> AsyncStorage -> memory fallback.
- Test env defaults to memory unless an adapter is injected.

Tour Pack keys:

- `tour_pack_passenger_<tourId>`
- `tour_pack_driver_<tourId>`
- `tour_pack_meta_passenger_<tourId>`
- `tour_pack_meta_driver_<tourId>`
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

Mobile service:

- `services/notificationService.js`

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

Safety service:

- `services/safetyService.js`

Safety roots:

- `tours/{tourId}/safetyAlerts`
- `tours/{tourId}/liveTracking`
- `globalSafetyAlerts`
- safety-related entries under `logs/{userKey}/safety`

Driver location:

- Canonical passenger/driver live bus path: `tours/{tourId}/driverLocation`.
- Driver Home writes manual and auto-share location updates there.
- Map screen listens there and presents freshness/staleness messaging.

Safety UX:

- `SafetySupportScreen` handles emergency options, trusted contacts, offline safety queue, and optional location sharing.
- The app opens emergency options and does not call 999 automatically.

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
- Driver assignment writes must align with the mobile canonical `currentTourId` contract and clean stale assignment links.
- User-facing errors should be sanitized, especially auth and password reset errors.
- Vite dev server adds basic security headers in `vite.config.js`; keep preview/deploy parity in mind.

---

## 9. Cloud Functions

Location: `functions/index.js`

Exported functions:

- `verifyPassengerLogin`
  - HTTPS `POST`
  - region `europe-west1`
  - reads `booking_identities/{bookingRef}`
  - optional backend App Check enforcement
  - rate limited by client key
- `processBroadcastWrite`
  - RTDB create trigger on `/broadcasts/{tourId}/{broadcastId}`
  - region `europe-west1`
  - validates admin author and writes `ADMIN_BROADCAST` chat message
- `sendChatNotification`
  - RTDB create trigger on `/chats/{tourId}/messages/{messageId}`
  - region `europe-west1`
  - validates sender/participants/admin broadcast authenticity
  - routes by `preferences.ops.group_chat` or `preferences.ops.driver_updates`
- `generatePhotoVariants`
  - Storage finalize trigger
  - region `us-east1`
  - creates server-owned viewer/thumbnail variants and updates photo metadata
- `sendItineraryNotification`
  - RTDB update trigger on `/tours/{tourId}/itinerary`
  - region `europe-west1`
  - sends to tour participants plus assigned driver auth users

Testing hook:

- `exports.__testables` exposes pure helpers for Node tests.

Maintenance scripts:

- `npm --prefix functions run backfill:photo-variants -- --dry-run --limit=50`

Photo variant backfill example:

```bash
npm --prefix functions run backfill:photo-variants -- --dry-run --limit=50
npm --prefix functions run backfill:photo-variants -- --apply --tourId=5112D_8 --limit=50
```

Use `--visibility=group|private`, `--tourId=...`, and `--ownerKey=...` to narrow photo variant backfills.
Broad apply runs without `--tourId` require `--allow-full-scan`.

---

## 10. Security Rules and Access

Sources:

- `database.rules.json`
- `storage_rules.json`

Important RTDB invariants:

- Root read/write are denied by default.
- `drivers`, `bookings`, `tours`, and `tour_manifests` must not expose collection-level authenticated reads.
- Passenger login uses `verifyPassengerLogin` to validate booking identity and create short-lived `tour_access_grants` / `booking_access_grants` before first tour access.
- Online passenger login must persist `users/{authUid}/bookingRef` before entering the app; that caller-owned profile link keeps exact manifest-row access working after short-lived grants expire.
- Driver-code login uses `verifyDriverLogin`; assignments resolve from `drivers/{driverId}/currentTourId`.
- Passenger manifest loading uses the `getTourManifest` HTTPS function; the mobile app must not scan `/bookings` to assemble manifests in production.
- Release order matters for backend access changes: deploy Functions first, then Realtime Database/Storage rules, then EAS update/build. Current EAS workflows test backend changes but do not deploy Firebase backend artifacts.
- `bookings/{bookingRef}` writes are admin-only.
- `tour_manifests/{tourId}/bookings/{bookingRef}` writes allow admin, verified assigned drivers, and passengers only for their own booking via `users/{authUid}/bookingRef` or a valid booking grant.
- `assigned_driver_codes` must use the canonical object payload.
- Chat message creates require ownership through auth UID, stable passenger identity binding, private owner identity, or verified driver principal.
- Chat reaction, typing, presence, and read-state actor leaves are identity-scoped.
- Private photos allow access by auth UID, raw stable identity, encoded stable key, raw private owner, encoded private owner key, or identity binding.
- `identity_bindings_meta` writes are admin or caller-owned binding only.
- `broadcasts` writes are admin-only and require numeric `createdAtMs`.
- `category_broadcasts` writes are admin-only, require numeric `createdAtMs`, and target canonical future-tour preference keys under `users/{uid}/preferences/marketing`.
- `users` validates push token metadata, identity metadata, driver helper fields, and notification preferences.
- `admin_users` is the web-admin privilege allowlist; entries must be boolean `true`.
- `ops_alerts` reads are admin-only through the hardcoded admin UID or `admin_users`; mobile writes must be bounded, sanitised, fingerprinted, and schema-valid.
- `globalSafetyAlerts` writes require admin or caller-owned pending event creation.

Important Storage invariants:

- `group_tour_photos/{tourId}/...` read/write requires authenticated user and image constraints for writes.
- `private_tour_photos/{tourId}/{ownerKey}/...` read/write requires the caller's encoded stable/private owner key or identity binding.
- Ownership is intentionally enforced in RTDB metadata, because Storage rules cannot look up stable identity bindings.

If changing any protected data shape, update all of:

1. Service code
2. Security rules
3. Tests
4. Contract docs
5. This `AGENTS.md` when the operating model changes

---

## 11. Tests

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

Current `test:emulators` runs reactions and manifest rules. If you change photo variant/photo ownership rules, also run the photo variant rules test directly with the emulator:

```bash
firebase emulators:exec --project demo-llt-rules --only database "node --test tests/firebaseRules/photoVariants.rules.test.js"
```

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
- `tests/stableIdentity.integration.test.js`
- `tests/validateBookingReference.passengerVerifier.test.js`
- `tests/offlineSyncService.test.js` and `__tests__/offlineSyncService.test.js`

Many root npm scripts use POSIX-style `NODE_ENV=test`. CI runs on Linux. On native Windows shells, use the same npm script first; if the shell rejects inline env assignment, run the underlying `node --test ...` command with `$env:NODE_ENV='test'` for local verification.

---

## 12. Build, Release, and Env

Mobile config:

- Use `app.config.js`; there is no static `app.json`.
- Version: `1.0.2`
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

OTA updates:

```bash
npm run update:dev
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
- Production GitHub Actions validate `EXPO_PUBLIC_*`, sync them into EAS production, then build/update.
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
  - production OTA update on `main` push or manual dispatch
  - verifies commit is on `main`
  - Node 24 plus Java 21 for Firebase emulators
  - installs root and Functions dependencies
  - runs mobile, Functions script, and Firebase rules tests
  - validates env and syncs EAS production env
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

```bash
cd functions
npm run serve
npm run deploy
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

- Stable passenger IDs must stay raw in profile fields but encoded in path keys.

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
- `docs/data-contracts/ops-alerts.md`
- `docs/data-contracts/tour-identity.md`
- `docs/offline-tour-pack.md`
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
