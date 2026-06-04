# Dependency Upgrade & Production Readiness Status

_Last updated: 2026-06-04_

## Scope

This note tracks the current dependency/release state for the mobile Expo app and Firebase Functions. The `web-admin` workspace is intentionally excluded from this sweep.

## Current direct dependency baseline

Mobile app:

- App version: `1.0.2`
- Expo SDK: `~55.0.0`
- React Native: `0.83.6`
- Firebase JS SDK: `^12.14.0`
- Expo Notifications: `~55.0.23`

Firebase Functions:

- `firebase-admin`: `^13.7.0`
- `firebase-functions`: `^7.1.1`
- `expo-server-sdk`: `^4.0.0`
- `sharp`: `^0.33.5`

## Current verification evidence

The previous March dependency audit is obsolete. The mobile app has already moved past that older baseline, and the available local dependency/security checks currently show:

- `npm audit --omit=dev`: `0 vulnerabilities`
- `npm --prefix functions audit --omit=dev`: `0 vulnerabilities`
- `npx expo-doctor`: `19/19 checks passed`
- `npm run test:mobile`: passed
- `npm run test:functions:scripts`: passed
- `npm run test:mobile:sync:contract`: passed after tightening chat, group-photo, broadcast, global safety, tour, and driver rules contracts
- Production Expo config introspection confirms iOS App Transport Security disables arbitrary network loads, iOS Always Location usage copy is not generated, Android microphone permission is blocked, and location permissions remain foreground-only.

## Remaining release gates

These are not dependency-upgrade blockers, but they are still required before final production release sign-off:

- `npm run validate:expo-env` must pass with real production `EXPO_PUBLIC_*` values. The local checkout currently only has placeholder/example values, so this command correctly fails.
- `npm run test:emulators` must pass in CI or on a machine with Java 21 installed. The local machine currently fails before running rules tests because `java` is not on `PATH`.
- Deploy Firebase Functions and Firebase rules before any production EAS update/build from this branch. The app now depends on the `verifyDriverLogin` and `getTourManifest` HTTPS functions, and the tightened RTDB rules assume those backend endpoints are available.

## Open release blockers and residual risks

The latest rules pass tightened several production risks: tour metadata writes, driver record creation, booking reads, tour reads, manifest reads, chat/internal-chat access, group-photo metadata access, broadcasts, and global safety alert reads are no longer broad authenticated access.

The high-risk login/manifest reads now move through verified backend contracts:

- Passenger verification writes short-lived `tour_access_grants` and `booking_access_grants` before the app joins or reads a tour.
- Passenger login now treats the caller-owned `users/{authUid}/bookingRef` profile write as critical before entering the app, so exact manifest-row access remains durable after the short-lived backend grants expire.
- Driver-code verification resolves driver assignment server-side, including legacy manifest assignment recovery.
- Passenger manifests are assembled by the `getTourManifest` HTTPS function instead of by client-side `/bookings` scans.
- The photo viewer now clears delayed scroll retry timers on close/unmount to avoid stale pager jumps after the viewer is dismissed.

The following areas still need confirmation before I would call the app fully production-ready:

- `npm run validate:expo-env` must pass with real production values in the release environment.
- `npm run test:emulators` must pass in CI or on a machine with Java 21 installed; the local machine currently cannot start Firebase emulators because `java` is missing on `PATH`.
- Firebase Functions and rules must be deployed in the correct order before the customer app is released: deploy Functions first, then Realtime Database/Storage rules, then publish the EAS update/build.
- Storage object rules now require writes to include matching caller auth metadata, but signed-in object reads and signed download URLs still mean effective photo visibility is enforced primarily by Realtime Database metadata.

The GitHub production build/update workflows install Java 21, run mobile tests, Functions script tests, Firebase emulator rules tests, validate Expo public env, sync EAS production env, and only then build/update.

## Native release metadata

Production builds now explicitly close iOS App Transport Security (`NSAllowsArbitraryLoads: false`) while leaving the looser dev-client network posture available outside the production EAS build profile. The Expo location plugin is configured to avoid generating iOS Always Location usage strings because the app only requests foreground location access.

Production binary workflows use EAS remote app version management with auto-increment, while `app.config.js` keeps the current local native build baselines (`ios.buildNumber: 3`, `android.versionCode: 3`). Binary workflows must read EAS remote version state before building so a missing or uninitialized remote counter cannot silently produce a duplicate or regressed store build number.

Production config introspection now also confirms release metadata cleanup removes Expo Dev Launcher iOS local-network copy (`NSBonjourServices` / `NSLocalNetworkUsageDescription`) and the Android `SYSTEM_ALERT_WINDOW` permission from the generated production native config.

The TestFlight workflow validates App Store Connect submit inputs before building, but only writes the `.p8` key and mutates the iOS submit profile after the EAS build completes. This keeps App Store Connect API key material out of the EAS build upload context.

Realtime Database driver rules no longer allow authenticated clients to list `/drivers`, and exact driver-record reads are limited to the claimed driver UID or admins. Driver-code login uses the verified backend endpoint so unclaimed driver records do not need to be readable from the app.

## Future modernization

No dependency upgrade is currently identified as a pre-production blocker for the mobile app or Functions based on the local audits above. Future work can still consider:

- gradual Firebase compat-to-modular migration in the mobile Firebase boundary,
- routine Expo SDK patch updates via `npx expo install --fix`,
- a planned QA window for the next major Expo/RN migration after this release.
