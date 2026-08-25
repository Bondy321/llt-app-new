# Modular architecture refactor baseline

## Starting point

- Starting commit: `f42e6d060c5cc6e762eb864b65326330173b002a`
- Starting branch: clean `main`, exactly equal to `origin/main` after fetch
- Working branch: `refactor/modular-feature-architecture`
- Baseline captured: 25 August 2026
- Runtime variance: the local workstation uses Node 24.19.0; `functions/package.json` declares Node 22 and CI must verify that declared runtime.

No Firebase deployment, EAS publication, production-data operation, or App Check change is part of this refactor.

## Clean-install and test baseline

| Command | Result | Classification / evidence |
| --- | --- | --- |
| `npm ci` | Passed | 1,273 packages installed from the committed root lockfile. Three existing moderate development-tool advisories; production audit is clean. |
| `npm --prefix functions ci` | Passed | 538 packages installed. Node 24 emitted the expected local engine warning for the declared Node 22 runtime. Two existing moderate development-test advisories. |
| `npm --prefix web-admin ci` | Passed | 364 packages installed; zero advisories. |
| `npm run test:mobile` | Passed | Every mobile core and extended sub-suite completed with zero failures. |
| `npm run test:functions:scripts` | Passed | 157/157 tests. |
| `npm run test:emulators` | Passed | 119/119 Realtime Database and Storage rules tests. |
| `npm run test:web-admin` | Passed | 3 component files (11 tests), 16 service files (86 tests), and 2 utility files (12 tests): 109/109 total. |
| `npm run build:web-admin` | Passed | Vite transformed 7,025 modules and completed a production build. |
| `npm run security:audit:release` | Passed | All three production dependency graphs have zero vulnerabilities. Existing moderate advisories are confined to root Firebase CLI/OpenTelemetry and Functions test tooling; the command's high-severity release gate passed. |

An initial attempt to run several suites concurrently caused Vitest workers to time out before importing tests. The identical `npm run test:web-admin` command passed when run independently; this is classified as a local resource/concurrency failure, not an existing code failure.

## Initial architecture metrics

The deterministic raw report is stored in `docs/architecture/refactor-baseline-report.json` and can be reproduced with `npm run architecture:report`.

| Production file | Bytes | Lines |
| --- | ---: | ---: |
| `functions/index.js` | 259,848 | 6,899 |
| `screens/ChatScreen.js` | 213,264 | 6,330 |
| `App.js` | 92,430 | 2,218 |
| `screens/SafetySupportScreen.js` | 91,050 | 2,808 |
| `screens/DriverHomeScreen.js` | 83,218 | 2,300 |
| `web-admin/src/components/ToursManager.jsx` | 81,299 | 2,174 |
| `screens/TourHomeScreen.js` | 80,353 | 2,578 |
| `screens/ItineraryScreen.js` | 78,732 | 2,203 |
| `services/bookingServiceRealtime.js` | 78,378 | 2,036 |
| `services/chatService.js` | 73,972 | 2,100 |
| `screens/PassengerManifestScreen.js` | 65,048 | 1,716 |
| `services/offlineSyncService.js` | 63,894 | 1,652 |
| `screens/PhotobookScreen.js` | 63,752 | 1,846 |
| `screens/NotificationPreferencesScreen.js` | 59,615 | 1,806 |
| `screens/MapScreen.js` | 52,392 | 1,495 |
| `web-admin/src/components/Dashboard.jsx` | 51,695 | 1,290 |
| `screens/GroupPhotobookScreen.js` | 48,522 | 1,458 |
| `services/photoService.js` | 48,512 | 1,364 |
| `components/ImageViewer.js` | 40,385 | 1,279 |
| `screens/LoginScreen.js` | 40,352 | 1,074 |

Other starting signals:

- 147 production source files were scanned.
- Zero circular production dependencies were detected.
- `functions/index.js` had 21 direct imports and eagerly imported both `sharp` and `expo-server-sdk`.
- 24 direct Firebase SDK import lines, 9 direct AsyncStorage/SecureStore import lines, and 8 fetch-shaped call lines were reported for classification.
- The baseline Vite build already split admin route chunks. Largest feature chunks were ToursManager 61.94 kB, Dashboard 48.24 kB, DriversManager 18.00 kB, BroadcastPanel 15.61 kB, and ContentModerationPanel 10.99 kB before gzip.

## Public compatibility inventory

Deployed Firebase Functions (35):

`assignDriverToTour`, `cleanupExpiredAppSessions`, `cleanupExpiredDriverLocations`, `cleanupExpiredDriverTourPacks`, `cleanupExpiredLoginRateLimits`, `cleanupNotificationReadState`, `createGroupPhotoChatMessage`, `createManualPassengerBooking`, `deleteGroupPhoto`, `deletePrivatePhoto`, `deleteTourData`, `endAppSession`, `generatePhotoVariants`, `getTourManifest`, `ingestDriverTourPacks`, `normalizeTourDateIndexes`, `normalizeTourEndDateIndex`, `processBroadcastWrite`, `processCategoryBroadcastWrite`, `processNotificationReadMigrationRequest`, `projectDriverTourPackActionState`, `removeReportedPhoto`, `resolveGroupPhotoMedia`, `resolvePrivatePhotoMedia`, `revokeAppSession`, `sendChatNotification`, `sendDriverTourPackChangeNotification`, `sendInternalChatNotification`, `sendItineraryNotification`, `sendSafetyAlertNotification`, `submitSafetyReport`, `uploadGroupPhoto`, `uploadPrivatePhoto`, `verifyDriverLogin`, `verifyPassengerLogin`.

The Functions module also exposes `__testables`; characterization tests preserve that test boundary.

Mobile route names (14):

`AccountPrivacy`, `Chat`, `DriverHome`, `DriverItinerary`, `DriverTourPack`, `GroupPhotobook`, `Itinerary`, `Login`, `Map`, `NotificationPreferences`, `PassengerManifest`, `Photobook`, `SafetySupport`, `TourHome`.

Complete public export sets for `chatService`, `bookingServiceRealtime`, and `photoService`, plus exact Function trigger paths, schedules, regions, and important resource settings, are locked by `tests/architecture/publicApiCompatibility.test.js`.

## Architecture risks at the baseline

- Composition roots own request parsing, domain rules, lifecycle state, presentation decisions, and persistence.
- Mobile screens combine subscriptions, network orchestration, persistence, domain calculations, modal state, and style declarations.
- Compatibility services combine validation, Firebase paths, HTTP, offline behavior, logging, and user-facing errors.
- Functions initialise Firebase Admin, Sharp, and Expo push infrastructure on the global import path.
- Backend domains share module-level mutable caches and broad implicit dependencies.
- High-risk contracts are duplicated between mobile, Functions, web admin, and Firebase rules without one canonical fixture source.
- Presentation-layer Firebase and persistence imports make security and cleanup invariants difficult to enforce locally.
- Existing large files make ownership, change isolation, and review boundaries unclear despite a green behavioral baseline.

## Planned compatibility boundaries

- `functions/index.js` remains the deployed CommonJS entry and re-exports the exact existing Function objects from a composition root.
- `App.js` remains Expo's root entry and delegates to a feature-based application root.
- `screens/ChatScreen.js` remains a compatibility wrapper.
- `services/chatService.js`, `services/bookingServiceRealtime.js`, and `services/photoService.js` remain stable facades until callers and tests prove delegation parity.
- Existing screen route names, Firebase paths, response reason codes, trigger options, session schema, opaque identity format, media metadata, notification routes, and rules stay unchanged.
- Functions receive deployment-local generated contract adapters; runtime code never imports outside the Functions deployment package.
