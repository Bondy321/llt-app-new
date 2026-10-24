# First-public-launch mobile reliability contract

Prepared 24 October 2026. This describes local implementation and automated acceptance; it does not assert deployment, App Check enrollment, a store build, or physical-device acceptance.

## Startup and local cleanup

Startup uses a single five-second network-decision budget for the current installation-session read and passenger profile hydration. Known-offline startup skips those reads. Only validated, exact, unexpired cached session/projection data is eligible. First authentication without an existing connection remains a connection-required flow. A disconnected phone cannot discover a previously unseen server revocation; privileged network access continues to depend on current server rules and live session validation.

Session projection writes, ordinary navigation writes and cleanup share the physical AsyncStorage adapter's serialization boundary. Cleanup closes new projection writes before waiting for dispatched native writes. It writes a durable pending-cleanup marker, removes exact scoped caches, then commits session-key removal. A failed cleanup blocks restoration and fresh-session publication until recovery succeeds. Successful fresh login explicitly reopens the boundary. Restore of historical detail routes always selects validated passenger or driver Home.

Ordinary logout, principal change and reassignment preserve unsent actions in their exact identity scope, pending server-session-end receipts, safety work and tracking-stop tombstones. Only accepted account deletion explicitly discards queued actions. None of these records is treated as disposable cache. Driver pack/action/manifest caches drain dispatched writes and fence stale generations. Logger and crash snapshots drain pending native writes, cancel timers and reject callbacks after cleanup until diagnostics reopen for authentication.

## Boarding and durable actions

Automatic reconnect/foreground replay and manual sync use the same manifest outcome publication. Before a successful queue item is removed, its authoritative result is persisted to the exact driver/tour manifest cache under queue serialization. A newer still-pending edit is overlaid; an older server result cannot erase it. Mounted controllers subscribe to persisted cache outcomes. Conflict details survive screen unmount and process-context recreation. A scope change invalidates reads and outcomes before another principal can see them.

Text chat saves the immutable action ID, payload and identity scope before clearing the draft or dispatching a transaction. Storage failure preserves the draft. Direct sends have an eight-second decision deadline; replay attempts default to fifteen seconds. A timeout releases the worker while retaining the same idempotency key for recovery. It does not cancel an already dispatched Firebase transaction.

Tour Pack mutations have unique immutable mutation IDs, independent of the existing target supersession key. Monotonic intent stamps include persisted queued/cache stamps. Pending changes to one target coalesce; a syncing predecessor retains its latest successor. Per-target rules admit idempotent same-state retries but reject older stamps and same-stamp conflicting state. Limited Command Centre access uses reviewed exact-driver flags or the explicit global flag, consistently in client and server admission. Generic TestFlight membership grants no capability.

## Media, notifications and admin links

Photo paging reserves both the inclusive cursor and the lookahead sentinel. Real SDK acceptance traverses at least 95 records, equal timestamps, deletion of a cursor already seen and concurrent insertion without truncation or duplication.

Chat publishes text immediately and renders retryable photo placeholders independently. Authorized media signing uses bounded batches and generation checks. Older notification targets use the same resolver, recheck deletion after signing, and refuse results for superseded identity. No permanent or public media URLs are introduced.

System notice taps and in-app opens share acknowledgement against the current verified principal. The installation UID remains the authenticated transport identity; it is not the notice owner. Failed acknowledgements stay retryable. Tests exercise the same UID changing from passenger to driver under production rules.

Admin `/tours?q=ID` uses an exact-record subscription. Its current value, including explicit deletion, overrides the bounded directory window. Changing the query or unmounting removes the exact subscription.

## Automated acceptance

- `tests/mobileLaunchBoundaries.test.js`: mounted navigation draining, failed cleanup/recreation, Home restoration, known-offline startup, late profile result, actual diagnostic adapters, mounted automatic/manual manifest reconciliation and logical identity change.

- `tests/mobileReliabilityJourneys.test.js`: durable chat failure/timeout, unrelated replay progress, immediate mixed media snapshots, partial resolver failure, older image targets/deletion, Tour Pack repeated intents/restart and unmounted manifest settlement with newer local work.

- `tests/mobileMediaPaging.emulator.test.js`: actual Firebase SDK gallery traversal, fresh offline SDK read, and two authorized driver handsets whose older boarding replay converges to server `NO_SHOW` after cache recreation.

- Existing `driverTourPacks.rules.test.js` and `notifications.rules.test.js`: late-old target rejection, explicit feature admission, canonical same-UID notice acknowledgement.

- `web-admin/src/components/ToursManager.test.jsx`: exact tour outside the bounded window remains live through edit, assignment/activity change and deletion at the same URL.

The launch evidence report must record final full-gate results and device/build acceptance separately. Earlier TestFlight build 15 results do not validate this new native dependency/configuration candidate.

## Admin build and authenticator prerequisites

Deployable `web-admin` builds require `VITE_FIREBASE_APPCHECK_SITE_KEY` from the real registered reCAPTCHA Enterprise App Check provider. Key shape validation cannot prove provider registration or domain authorization; those external settings must be verified before release. No placeholder key or fake provider is supplied. `npm run build -- --mode verification` compiles to `verification-dist` only and must never be deployed; ordinary `npm run build` fails before bundling when the key is missing.

Admin enrollment requires verified email, recent password reauthentication, a six-digit TOTP and the same auth user throughout. Privileged server endpoints and rules require the current TOTP sign-in claim; merely enrolling a factor does not satisfy this. Headers bind ID and App Check tokens to the current auth user and fail if the provider stalls or rejects.

## Supported first-launch passenger surface

Production and TestFlight builds/updates explicitly set `EXPO_PUBLIC_PASSENGER_TRIP_ENABLED=true`. The release validator rejects a missing or disabled flag so the tested current-session snapshot, conditional refresh and offline restart path cannot silently fall back to the older screen data path. Development/preview keep their explicitly selected flag. Generic TestFlight membership does not enable Command Centre: both build eligibility defaults are false and runtime writes still require the reviewed exact driver/global server feature authorization.

Native EAS Build and both TestFlight jobs (including reuse of an existing build) require the manual `prerequisites_verified` checkbox in addition to exact-SHA CI and runtime trust checks. The checkbox records the operator’s review of deployed backend/rules, real provider configuration and the exact candidate; it is not evidence that those external steps have been performed here.

Uploads validate decoded image format and dimensions before reservation (10 MiB encoded, 16 megapixels decoded, maximum dimension 8192, one frame; JPEG/PNG/WebP and codec-supported HEIC). The bounded decoder loads through the storage infrastructure adapter. New media remains unavailable to signing until restricted RTDB publication commits under the exact session, tour lifecycle and record lock. A five-minute durable operation deadline and indexed 25-record scheduled sweeper recover interrupted requests. Cancelled uploads retain a zero-byte storage sentinel at the original source path: a delayed generation-zero upload cannot recreate passenger bytes. Normal deletion never removes these sentinels. The operation tombstone and empty object are deliberately retained security state, not a disposable cache.

Signed URL issuance rechecks the exact current session and record after signing. Previously delivered URLs remain usable until their five-minute expiry; this is not immediate revocation of an already-issued URL. Source-finalization events wait for committed publication, skip cancellation sentinels, and recover cancelled operations before processing variants. These new server functions and rules must be deployed together before enabling uploads from the release candidate.

The scheduled cleanup emits `Media upload cleanup health` with only `inspected`, `cleaned`, `deferred` and `oldestDueAgeMs`. Monitor nonzero deferred work and a rising oldest due age across consecutive five-minute runs; these are operational failures, not a successful cleanup. No customer identifiers or storage paths are logged.

Completed-photo deletion removes the original source bytes and replaces each deterministic viewer/thumbnail target with a zero-byte generation-guarded sentinel, even if that target does not yet exist. Variant workers write only with generation-zero preconditions and may reuse only the exact source generation and variant role. This prevents a delayed derivative write from recreating deleted customer pixels after deletion has finished. Empty sentinels are intentionally retained; physical absence of every Storage object is not the acceptance criterion.

Direct gallery signing and deletion requests have a 15-second total client deadline; uploads have 45 seconds including local file, token, App Check, transport and response-body work. Exact Firebase auth-object replacement invalidates the operation even when the UID is unchanged. A timeout is retryable and does not claim the server cancelled an already-dispatched upload. Stable idempotency prevents duplicate committed photos, while retries after cancelled-attempt cleanup use a fresh operation-specific source path.

The Firebase Storage emulator used for local acceptance does not enforce GCS generation preconditions. Actual emulator tests verify byte removal, retained empty markers and metadata/authority behavior; conditional late-write rejection is separately exercised by a storage-boundary adapter that implements generation preconditions. The installed GCS SDK passes those preconditions to the service, but this run does not claim a live GCS race test. A disposable staging-bucket acceptance must confirm that a delayed generation-zero upload cannot replace a cancellation marker before public launch.

Native App Check expiry parsing uses a bounded portable UTF-8/base64url decoder and does not depend on browser globals in Hermes. An isolated-runtime regression removes `atob`, `Buffer` and `TextDecoder` while exercising real Unicode claims and malformed input. This parser reads expiry only; it never establishes token authenticity.

## Final scope coverage and request decisions

| Finding | Implemented boundary | Retained acceptance |
| --- | --- | --- |
| F07 durable chat | Persist immutable text intent before draft clearance; bound replay; retain ambiguous completion for the same-ID retry | `mobileReliabilityJourneys`, `offlineSyncService` |
| F09 limited driver actions | Unique mutation IDs, target supersession and monotonic stamps; global/exact-driver admission covers metadata and issues as well as operational state | `mobileReliabilityJourneys`, `driverTourPackActionService`, `driverTourPacks.rules`, recursive `driverTourPackBoundary.contract` |
| F10 pagination | Inclusive cursor plus lookahead; group/private traversal through exhaustion | `mobileMediaPaging.emulator` with 95+ records |
| F11–F12 chat media | Immediate text and bounded independent signing; shared older-target resolver; deletion and identity fences | `mobileReliabilityJourneys`, mounted live-window regression in `mobileLaunchBoundaries` |
| F13 process restoration | Parameter-dependent historical routes select verified Home | `mobileLaunchBoundaries` |
| F14 notices | Current canonical principal for single/batch acknowledgement; permission failures remain retryable | `mobileReliabilityJourneys`, `notifications.rules` |
| F15 admin exact tour | Current exact subscription overrides bounded directory data, including explicit deletion | `ToursManager.test.jsx` |

Passenger snapshot requests now have a total 15-second decision deadline covering ID token, App Check, fetch and body work. Cancellation releases the controller even if a provider ignores AbortSignal. Requests discard results after the exact auth object changes. Account deletion uses the same bounded transport but retains its previously persisted receipt and requesting state on an unconfirmed result; recovery still checks that receipt rather than assuming timeout cancelled deletion.

Admin HTTP operations share a 20-second total deadline and exact auth-object checks. This includes audience preview, manual passenger creation and privileged mutations. Timeout copy explicitly says that the operation may have completed and instructs the operator to inspect the current record before retrying. The error does not claim that a passenger was definitely not added. Tests pause token, App Check, transport and response-body stages, then release them after the deadline and verify no late dispatch/result is accepted.

The final follow-up regressions live in existing mandatory `bookingNetworkDeadline.test.js` and `accountDeletionService.test.js`, plus `web-admin/src/services/adminHttpRequest.test.js` (included by the required services test glob). Their final result belongs in the integrated evidence report after the final run; source preparation alone is not a passed test.

Caption edits also release the saving state after a 15-second decision deadline. An unconfirmed edit stays open with instructions to reopen the photo and inspect the authoritative caption before retrying. The SDK write may still complete; timeout neither retries nor deletes it. The mandatory photo service suite retains that regression.

Final focused follow-up (24 October): the 125-case mobile batch had 123 passes and two obsolete fixture assertions; both were corrected and all 23 tests in the affected suites passed. Admin HTTP deadline, passenger and MFA tests passed 23/23. Real SDK TourPack tests passed 8/8, including denial of metadata and issue writes when the feature is disabled. Scoped ESLint passed and the architecture check passed for 611 production source files. Evidence is in the sibling verification/2026-10-23-first-launch directory under mobile-final-deadlines, mobile-final-fixtures, mobile-admin-deadlines and mobile-tourpack-disabled-sdk logs. These focused checks do not replace the final integrated gate or physical-device and provider acceptance.


## Current candidate and recovery identity

The current app version and native runtime are **1.1.0**. New iOS and Android binaries are required for the native Firebase App Check dependencies/configuration. An OTA or the historical 1.0.7 build-15 phone tests do not establish native acceptance for this candidate. The exact-binary phone record and production/provider preparation are in [the first-launch checklist](first-public-launch-2026-10-24.md#exact-binary-phone-acceptance-record); all physical-device rows remain unperformed until evidence is recorded there.

Receipt-status recovery may replace only the exact Firebase User object captured by the recovery request. A delayed old-token rejection must not sign out a successor, including a new User object with the same UID. `freshAnonymousAuth` checks the expected object after restoration and each asynchronous preparation stage, and checks the request deadline before further authentication mutations. The mandatory account-deletion service suite covers paused token failure, restoration/storage continuation, deadline expiry and the normal replacement path. The saved receipt remains available when recovery cannot confirm its result.

The 24 October dependency follow-up is documented in [the certificate/dependency record](certificate-trust-2026-10-23.md#24-october-dependency-advisory-follow-up): Zod 4.6.6 with a reviewed exact Expo CLI override, body-parser 1.20.9/2.4.0 preserving consumer majors, and mandatory tests against actual Expo/MCP consumers and real HTTP decompression behavior. Use the final integrated evidence record for installed versions/audit/test results; this implementation document is not a deployment or store-release attestation.

The mounted `DriversManager.test.jsx` staff-enrolment tests mock the checked admin service boundary, keeping Firebase/provider initialization out of component tests. They hold issuance responses pending, confirm that no secret appears early, clear previous secrets immediately on replace/revoke, and keep unconfirmed-operation copy truthful. Driver changes remount the enrolment component through its existing exact-driver key.

Remaining owner conditions for the mobile launch are finite:

1. Use the delivered candidate's successful exact-commit checks and audits; recheck them if selecting a different revision for publication.
2. Configure and verify real iOS/Android Firebase App Check identities, EAS platform files, Android signing/Play Integrity and admin reCAPTCHA Enterprise/TOTP access; complete current store-account requirements.
3. Deploy the reviewed matching backend/rules/admin/importer release and confirm production tokens are accepted while invalid/missing tokens are rejected. Keep global Command Centre disabled and passenger snapshots enabled.
4. Complete the authorized disposable GCS generation-precondition check; emulator byte-cleanup evidence does not establish that provider race.
5. Build both 1.1.0 binaries and complete the existing exact-binary phone matrix: two-phone passenger access/logout, staff enrolment/revocation, cold offline/reconnect/process death, locked-screen tracking and Stop/reassignment, media/older notification targets, and real-content deletion recovery.
6. Record build/commit/backend/device identifiers, required privacy/store disclosures and monitoring, then explicitly approve public publication.

## Native toolchain compatibility correction

RNFirebase 27 requires Android API 24 and Kotlin Gradle plugin 2.4.0 or newer; its Apple Firebase 13 integration uses dynamic frameworks. The candidate retains iOS 15.1 and dynamic frameworks and pins Android Kotlin 2.4.0. This follows the version-specific [RNFirebase 27 migration guide](https://rnfirebase.io/migrating-to-v27) and the supported [Expo build-properties configuration](https://docs.expo.dev/versions/latest/sdk/build-properties/).

The installed Expo 55 KSP lookup does not contain Kotlin 2.4. The narrow `withFirebaseAndroidToolchain` plugin therefore uses Expo's existing version-catalog override for KSP 2.3.12, pins the root Kotlin classpath, and sets the actual AsyncStorage 2.2.0 property `AsyncStorage_next_kspVersion`. The next-storage backend remains disabled. [KSP 2.3.12](https://github.com/google/ksp/releases/tag/2.3.12) requires AGP 8.12.0 or newer, matching the installed React Native catalog. No compiler metadata check is bypassed and no installed dependency is patched.

The mandatory `nativeToolchain.test.js` executes installed Expo mod providers against the installed Expo Android template in a disposable directory. It checks generated Gradle files and properties, unchanged surrounding configuration, idempotence, and rejection of missing, mixed or duplicate anchors. The native config guard also rejects missing or invalid iOS targets. Together with `nativeAppCheck.test.js`, the focused run passed 7/7; scoped lint evidence is recorded alongside `native-config-final.log` in `verification/2026-10-24-first-public-launch` outside the repository. This validates generated configuration, not a complete prebuild, Gradle/Xcode compilation, provider registration or physical-device behavior. New native builds and the exact-binary acceptance above remain required.
