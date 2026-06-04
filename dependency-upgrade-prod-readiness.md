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

## Open release security risks

The latest rules pass tightened several production risks: tour metadata writes, driver record creation, chat/internal-chat access, group-photo metadata access, broadcasts, and global safety alert reads are no longer broad authenticated access.

The following areas still need a server-contract or data-model change before I would call the app fully production-ready:

- `bookings` reads are still available to any authenticated client because passenger login reads booking/tour details after the verifier returns identifiers.
- `drivers` and `tour_manifests` reads are still broad because driver-code login currently reads `drivers/{code}` and scans manifests before the driver profile is claimed.
- `tours` reads are still broad because passenger login and `joinTour` read the tour before the participant row exists.
- Storage object rules now require writes to include matching caller auth metadata, but signed-in object reads and signed download URLs still mean effective photo visibility is enforced primarily by Realtime Database metadata.

The GitHub production build/update workflows install Java 21, run mobile tests, Functions script tests, Firebase emulator rules tests, validate Expo public env, sync EAS production env, and only then build/update.

## Native release metadata

Production builds now explicitly close iOS App Transport Security (`NSAllowsArbitraryLoads: false`) while leaving the looser dev-client network posture available outside the production EAS build profile. The Expo location plugin is configured to avoid generating iOS Always Location usage strings because the app only requests foreground location access.

Production binary workflows use EAS remote app version management with auto-increment, while `app.config.js` keeps the current local native build baselines (`ios.buildNumber: 3`, `android.versionCode: 3`). Binary workflows must read EAS remote version state before building so a missing or uninitialized remote counter cannot silently produce a duplicate or regressed store build number.

Production config introspection now also confirms release metadata cleanup removes Expo Dev Launcher iOS local-network copy (`NSBonjourServices` / `NSLocalNetworkUsageDescription`) and the Android `SYSTEM_ALERT_WINDOW` permission from the generated production native config.

The TestFlight workflow validates App Store Connect submit inputs before building, but only writes the `.p8` key and mutates the iOS submit profile after the EAS build completes. This keeps App Store Connect API key material out of the EAS build upload context.

Realtime Database driver rules no longer allow authenticated clients to list `/drivers`; exact driver-code reads remain allowed for login, and emulator coverage has been added for exact-read/list-deny behavior.

## Future modernization

No dependency upgrade is currently identified as a pre-production blocker for the mobile app or Functions based on the local audits above. Future work can still consider:

- gradual Firebase compat-to-modular migration in the mobile Firebase boundary,
- routine Expo SDK patch updates via `npx expo install --fix`,
- a planned QA window for the next major Expo/RN migration after this release.
