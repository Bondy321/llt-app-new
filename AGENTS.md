# Loch Lomond Travel (LLT) App - Agent Onboarding & Current System Status

Welcome, Agent. This file is the operational source of truth for contributors working in this repo.

**Last Updated:** April 8, 2026 (post stable-identity + sync-contract hardening)

---

## Table of Contents

1. [System Architecture Overview](#1-system-architecture-overview)
2. [Technology Stack](#2-technology-stack)
3. [Repository Structure](#3-repository-structure)
4. [Data Model & Backend Contracts](#4-data-model--backend-contracts)
5. [Authentication & Identity Model](#5-authentication--identity-model)
6. [Mobile App Features & Screens](#6-mobile-app-features--screens)
7. [Services Layer (Mobile)](#7-services-layer-mobile)
8. [Web Admin Dashboard](#8-web-admin-dashboard)
9. [Cloud Functions (Gen 2)](#9-cloud-functions-gen-2)
10. [Security Rules & Access Constraints](#10-security-rules--access-constraints)
11. [Testing Strategy & Commands](#11-testing-strategy--commands)
12. [Build, Release, and Runtime Notes](#12-build-release-and-runtime-notes)
13. [Engineering Contracts & Conventions](#13-engineering-contracts--conventions)
14. [Known Risks / Watch List](#14-known-risks--watch-list)
15. [Agent Directives (Must Follow)](#15-agent-directives-must-follow)
16. [Quick Reference](#16-quick-reference)

---

## 1. System Architecture Overview

LLT is a multi-surface system:
- **Mobile app** (Expo / React Native) for passengers + drivers
- **Web admin** (React + Vite + Mantine) for ops team
- **Firebase Cloud Functions Gen 2** for notification fanout + verifier endpoints + migration helpers

### Core data flow

```text
Google Sheets CMS
   -> Apps Script sync
      -> Firebase Realtime Database (source of truth)
         -> Mobile app
         -> Web admin
         -> Cloud Functions (notifications/verifiers/migrations)
```

### Operational region

**All Firebase resources are in `europe-west1`**. New backend code must explicitly keep this region.

---

## 2. Technology Stack

### Mobile app
- React Native `0.81.5`
- Expo SDK `54` (`expo ~54.0.33`)
- React `19.1.0`
- Firebase JS SDK `^12.10.0`
- react-native-maps `1.20.1`
- expo-notifications `~0.32.16`
- expo-secure-store `~15.0.8`
- @react-native-async-storage/async-storage `2.2.0`
- @react-native-clipboard/clipboard `^1.16.3`

### Web admin
- React `^19.2.0`
- Vite `^7.2.4`
- Mantine `^8.3.9`
- Firebase `^12.6.0`
- Vitest `^4.0.18`

### Backend (Functions)
- firebase-functions `^7.1.1` (Gen 2 APIs)
- firebase-admin `^13.7.0`
- expo-server-sdk `^4.0.0`
- Functions runtime target: Node `24`

---

## 3. Repository Structure

```text
/llt-app-new
├── App.js
├── app.config.js
├── firebase.js
├── theme.js
├── screens/
├── components/
├── services/
├── utils/
├── hooks/
├── tests/                 # Node test suites (mobile + contracts)
├── __tests__/             # additional mobile/service tests
├── docs/                  # architecture and contract docs
├── functions/             # Firebase Functions Gen 2
└── web-admin/             # Vite React admin dashboard
```

### Notable additions since early 2026
- `services/identityService.js` + identity migration helpers
- `services/offlineLoginResolver.js` for offline login gating
- `utils/unifiedSyncContract.js` shared sync-state taxonomy
- `docs/reactions-write-contract.md` (canonical reaction write rules)
- web-admin parity tests (`healthContractParity`, URL filter sync coverage)

---

## 4. Data Model & Backend Contracts

Primary Realtime DB roots (do **not** rename):
- `tours`
- `bookings`
- `tour_manifests`
- `drivers`
- `users`
- `chats`
- `internal_chats`
- `group_tour_photos`
- `private_tour_photos`
- `identity_bindings`
- `identity_bindings_meta`
- `broadcasts`

### Important modernized contracts

1. **Driver assignment contract**
   - Canonical active assignment key is `drivers/{driverId}/currentTourId`
   - `activeTourId` exists as legacy fallback only
   - Multi-path updates must keep `drivers`, `tour_manifests`, and related context in sync

2. **Chat reaction contract**
   - Canonical write path:
     - `chats/{tourId}/messages/{messageId}/reactions/{emoji}/{userId} = true`
   - Never overwrite `reactions/{emoji}` for toggle logic
   - Legacy array/object reaction shapes are read-compatible only

3. **Manifest sync conflict policy**
   - Compare local/server `lastUpdated`
   - Newer timestamp wins
   - Server-win path must reconcile local cache + user feedback

4. **Sync-state taxonomy contract**
   - `OFFLINE_NO_NETWORK`
   - `ONLINE_BACKEND_DEGRADED`
   - `ONLINE_BACKLOG_PENDING`
   - `ONLINE_HEALTHY`

---

## 5. Authentication & Identity Model

Authentication remains anonymous Firebase auth at foundation, but login modes are more explicit:

### Passenger login
- Booking reference + passenger email verifier flow
- `validateBookingReference()` integrates Cloud Function verifier responses
- Verifier reasons are mapped to deterministic UX reasons (`INVALID_CREDENTIALS`, `TRY_AGAIN_LATER`, `INTERNAL_ERROR`, `METHOD_NOT_ALLOWED`, etc.)

### Driver login
- Driver codes (`D-*`) map to driver records and assignment context
- Successful login hydrates immediate Driver Home tour context

### Stable passenger identity (critical)
- Canonical identity format: `pax_v1:{BOOKING_REF}:{normalized_email}`
- Stored under user profile and binding paths
- Used in chat/photo/rules ownership checks

### Offline login behavior
- Cached-session/Tour Pack identity permits offline re-entry for known users
- Unknown first-time codes remain blocked offline with explicit reason mapping

---

## 6. Mobile App Features & Screens

Core screens (mobile):
- `LoginScreen`, `TourHomeScreen`, `DriverHomeScreen`, `PassengerManifestScreen`
- `ItineraryScreen`, `DriverItineraryScreen`
- `ChatScreen`, `MapScreen`
- `PhotobookScreen`, `GroupPhotobookScreen`
- `NotificationPreferencesScreen`, `SafetySupportScreen`

### UX hardening that is now expected
- Non-blocking sync feedback (banner-first, fewer blocking alerts)
- Chat unread anchors + jump-to-unread behavior
- Pull-to-refresh tied to real queue replay outcomes
- Driver location freshness/staleness messaging for both driver and passenger surfaces

---

## 7. Services Layer (Mobile)

Key services and responsibilities:

- `bookingServiceRealtime.js`
  - login validation
  - join tour / driver assignment flows
  - passenger verifier integration
- `offlineSyncService.js`
  - Tour Pack caching
  - queueing/replay for manifest/chat/internal chat/photo uploads
  - `buildSyncSummary`, `formatSyncOutcome`, `lastSuccessAt`
- `chatService.js`
  - group/internal chat sends/subscriptions
  - reaction leaf writes and normalization
  - read-state + typing/presence paths
- `photoService.js`
  - group/private uploads + metadata handling
- `notificationService.js`
  - push token + preference persistence behavior
- `identityService.js`
  - stable identity helpers and migration support
- `itineraryDateParser.js`, `pickupTimeParser.js`, `timeUtils.js`
  - strict date/time parsing contracts
- `loggerService.js`
  - structured + safe logging conventions

---

## 8. Web Admin Dashboard

Location: `web-admin/`

Main surfaces:
- `Dashboard`
- `DriversManager`
- `ToursManager`
- `BroadcastPanel`
- `Settings`

### Current operational expectations
- Tours status filter and URL query param are synchronized both directions
- “All Tours” removes `status` query param (canonical URL behavior)
- Driver assignment writes align with mobile’s canonical `currentTourId`
- Health/sync semantics are mapped to same shared taxonomy as mobile

---

## 9. Cloud Functions (Gen 2)

Location: `functions/index.js`

Current exported functions include:
- `verifyPassengerLogin` (HTTPS verifier endpoint)
- `normalizeRecentBroadcastTimestamps` (migration helper)
- `processBroadcastWrite` (broadcast -> chat fanout)
- `migrateLegacyAnnouncementsToBroadcasts` (migration helper)
- `sendChatNotification` (DB trigger)
- `sendItineraryNotification` (DB trigger)

### Function-level requirements
- Gen 2 syntax only
- Explicit region `europe-west1`
- Defensive validation for payloads and path params
- Notification delivery protections:
  - deterministic chunking
  - recipient caps
  - token invalidation handling
  - preference-aware routing

---

## 10. Security Rules & Access Constraints

Source: `database.rules.json`

Highlights:
- Rules are now strict on schema validation for major collections
- Identity-aware writes allow ownership through:
  - raw `auth.uid`
  - `users/{uid}/stablePassengerId`
  - `users/{uid}/privatePhotoOwnerId`
  - `identity_bindings/{stablePassengerId}/{uid}`
- Reactions are user-leaf writes only (parent reaction writes blocked)
- `users` now validates push token state metadata and identity metadata fields

If changing data shape under any protected path, update:
1) service code, 2) security rules, 3) tests, 4) docs contract(s).

---

## 11. Testing Strategy & Commands

### Root test orchestration

```bash
npm test
npm run test:all
npm run test:all:fast
npm run test:all:full
npm run test:all:with-emulators
```

### Mobile segmented suites

```bash
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

### Web admin tests

```bash
npm run test:web-admin
# or
cd web-admin && npm run test
```

### Emulator-only rules tests

```bash
npm run test:emulators
```

---

## 12. Build, Release, and Runtime Notes

### Mobile
- Config is in `app.config.js` (not static `app.json`)
- EAS profiles are in `eas.json`
- Runtime version policy is `appVersion`

Build/update commands:

```bash
npm run build:dev:ios
npm run build:dev:android
npm run build:dev:ios-device
npm run build:preview
npm run build:production
npm run update:dev
npm run update:prod
```

### Web admin

```bash
cd web-admin
npm run dev
npm run build
npm run preview
```

### Functions

```bash
cd functions
npm run serve
npm run deploy
npm run logs
```

Migration helpers:

```bash
npm --prefix functions run migrate:assigned-driver-codes
npm --prefix functions run migrate:private-photo-owners
```

---

## 13. Engineering Contracts & Conventions

1. **Region**: Always `europe-west1` for backend resources.
2. **Dates**: Never rely on locale parsing for itinerary/pickup dates.
   - Accept only explicit UK (`dd/MM/yyyy`) or ISO (`yyyy-MM-dd`) formats.
3. **Assignment writes**: Use service helpers + multi-path updates.
4. **Sync contract**: Reuse shared taxonomy/formatters; do not fork wording by screen.
5. **Reaction writes**: User-leaf writes only; no parent overwrite toggles.
6. **Logging**: Use safe logging conventions (`docs/safe-logging-conventions.md`).
7. **Service return shape**: preserve `{ success: true|false, data|error }` style.
8. **Optional service loading**: use `optionalServiceLoader` pattern where applicable.

---

## 14. Known Risks / Watch List

1. **Date parsing drift risk**
   - Avoid `new Date("dd/MM/yyyy")` and any locale-dependent parsing.
2. **Identity migration edge cases**
   - Legacy `privatePhotoOwnerId` and stable identity bindings must remain compatible during gradual rollout.
3. **Offline queue growth**
   - Retry-bounded and processed-ID trimming are mandatory; avoid unbounded local growth.
4. **Function fanout scale**
   - Keep recipient caps/chunk sizes and caching tuned as participant counts grow.
5. **Rules/code divergence**
   - Schema changes without parallel rule/test updates are the highest-risk regression source.

---

## 15. Agent Directives (Must Follow)

1. Do **not** rename core DB roots (`drivers`, `tours`, `users`, `bookings`, `tour_manifests`, etc.).
2. Use shared helpers/contracts before introducing new abstractions.
3. Any data-shape change requires matching updates in:
   - services
   - security rules
   - tests
   - docs contract(s)
4. New Cloud Functions must be Gen 2 and region-pinned.
5. Keep UX feedback non-blocking where established (status banners + retry affordances).
6. Never commit secrets; use EAS/Firebase managed secret channels.

---

## 16. Quick Reference

### High-signal files
- `README.md`
- `docs/date-contract.md`
- `docs/date-contract-web-admin.md`
- `docs/data-contracts/driver-assignment.md`
- `docs/offline-tour-pack.md`
- `docs/reactions-write-contract.md`
- `docs/safe-logging-conventions.md`
- `database.rules.json`
- `functions/index.js`

### Common commands

```bash
# mobile
npm start
npm run start:dev

# tests
npm test
npm run test:web-admin

# web admin
cd web-admin && npm run dev

# functions
cd functions && npm run serve
```

### Admin UID (hardcoded in rules)

`9CWQ4705gVRkfW5Xki5LyvrmVp23`

---

Update this document whenever architecture, contracts, or operating conventions change materially.
