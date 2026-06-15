# LLT App Release Readiness Review

Review date: 2026-06-11

Scope: `llt-app-new`, excluding `web-admin`.

## Verdict

Do not publish yet. The mobile app and Firebase rules have a strong amount of test coverage and the main suites pass, but this final pass found several pre-publish blockers. Once the blockers below are closed, the app should be ready for App Store / Play Store publication from a repo-side reliability and security perspective, assuming the release validation commands and physical-device App Review checklist also pass on the exact production/TestFlight build.

The most important code blockers are:

- An unauthenticated Realtime Database write path under `/logs/anonymous/**`.
- A passenger login rate limit that can reject legitimate launch cohorts behind the same NAT/IP/user-agent.
- Offline/cache persistence using SecureStore for large durable payloads, with silent fallback to memory after adapter errors.
- Current production dependency audit failures in both the app tree and Cloud Functions tree.

Operational release blockers also remain: production env validation, deployed Functions/rules/storage, App Review privacy/sign-off work, live reviewer data, and real device testing.

## Review Scope

Reviewed owned source, app config, EAS config, Firebase rules, Cloud Functions, scripts, mobile services, screens, hooks, utilities, tests, and release docs.

Excluded from detailed review:

- `web-admin`, per request.
- Generated/vendor/local output: `.git`, `.expo`, root `node_modules`, `functions/node_modules`, Android Gradle/CMake/build output, and debug logs.
- Live production data and App Store Connect settings, except where release docs describe them.

Scratch notes are in `review_scratchpad.md`.

## Validation Run

Passed:

- `npm run test:mobile`
- `npm run test:functions:scripts`
- `npm run test:emulators` using Java 21
- `npx expo-doctor`, 19/19 checks passed after Expo loaded `.env.local`

Failed or still gated:

- `npm run validate:expo-env` failed when run without exported env vars. It reported missing required Firebase public config and Google Maps key. This is expected locally unless the release env is loaded, but it must pass in CI/EAS production.
- `npm run validate:expo-env` also failed when `.env.local` was explicitly loaded because `EXPO_PUBLIC_SUPPORT_PHONE` still looks like a placeholder or unresolved EAS alias.
- `npm audit --omit=dev` failed with one critical advisory: `shell-quote@1.8.3` via `react-native -> react-devtools-core`.
- `npm --prefix functions audit --omit=dev` failed with one high advisory: `@grpc/grpc-js@1.14.1` via `firebase-admin -> @google-cloud/firestore -> google-gax`.

The passing test suites do not cover every blocker listed below. In particular, the emulator rules suite does not currently include a deny test for unauthenticated writes to `/logs/anonymous/**`.

## Absolute Blockers

### B1. Unauthenticated writes are allowed under `/logs/anonymous/**`

Evidence:

- `database.rules.json:384-389`
- Related writers:
  - `services/loginDiagnosticsService.js:296-305`
  - `services/loggerService.js:348-381`
  - `services/crashDiagnosticsService.js:231`
  - `services/safetyService.js:264`, `services/safetyService.js:319`, `services/safetyService.js:432`

What is happening:

`database.rules.json` allows this write condition:

`$userId === 'anonymous' || (auth != null && (...))`

That means anyone with the public Firebase config can write arbitrary data under `/logs/anonymous/**` without being signed in. There is also no branch-level schema or size validation for those anonymous log writes.

Why this blocks publish:

At launch scale this is a direct cost, data-pollution, and denial-of-service risk. A malicious or buggy client can generate unlimited anonymous log records without authentication. Since the app is about to get many users quickly, this should be closed before exposing the Firebase project broadly.

Expected fix:

- Remove unauthenticated direct writes to `/logs/anonymous/**`.
- Prefer `auth != null` for every `/logs/$userId/**` write. If anonymous diagnostics are still needed before auth is available, send them through a rate-limited HTTPS/Callable Function that performs schema validation and rejects oversized payloads.
- Add explicit validation for known log branches, especially `loginDiagnostics`, `crashDiagnostics`, and `safety`.
- Consider writing unauthenticated startup diagnostics only locally until the user has an auth UID.

Verification:

- Add Firebase rules emulator tests proving unauthenticated writes to `/logs/anonymous/...` fail.
- Add tests proving signed-in users can write only bounded records under their own UID.
- Add tests proving admin can still read/write operational logs.
- Re-run `npm run test:emulators`.

### B2. Passenger login rate limiting can block legitimate launch cohorts

Evidence:

- `functions/index.js:1239-1254` derives a client key from IP plus `x-client-id` or user-agent.
- `functions/index.js:1256-1270` rate limits `verifyPassengerLogin` to 12 requests per minute for that client key before token verification.
- `services/bookingServiceRealtime.js` maps `TRY_AGAIN_LATER` to a visible passenger login failure.

What is happening:

The passenger verifier applies:

`checkRateLimit("verify_passenger_login_${clientKey}", 12, 60000)`

before the request is tied to a verified Firebase Auth UID. On mobile, many clients can share the same user-agent, and many legitimate passengers can share the same public IP behind a hotel, bus, ferry terminal, tour office Wi-Fi, carrier NAT, or corporate network.

Why this blocks publish:

The launch scenario is exactly the scenario this can hurt: many passengers trying to log in quickly from a small set of networks. The thirteenth passenger in one minute behind the same IP/user-agent can receive a rate-limit failure even with valid credentials. That is a high-risk first-run failure mode.

Expected fix:

- Verify the Firebase Auth token first.
- Rate limit by a key that includes `auth.uid`.
- Include a normalized booking reference/email hash or similar credential dimension so one user cannot brute force across many refs.
- Keep IP in the signal, but do not make shared IP/user-agent the main limiter.
- Increase the launch-safe burst limit for distinct authenticated users behind one IP.
- Consider a durable limiter if the function scales across instances; the current in-memory limiter is inconsistent across cold starts and instances.

Verification:

- Add function tests for 20 to 50 distinct authenticated UIDs behind the same IP/user-agent and verify they can all attempt login without hitting the shared limiter.
- Add tests proving one UID brute forcing many refs is still limited.
- Re-run `npm run test:functions:scripts`.
- Smoke test passenger login on the deployed production Functions endpoint from multiple devices on the same Wi-Fi.

### B3. Offline/cache persistence uses SecureStore for large durable data and can silently become memory-only

Evidence:

- `services/persistenceProvider.js:66-86` places `secure-store` first for native runtimes.
- `services/persistenceProvider.js:154-164` falls back to memory after selected adapter errors.
- `services/offlineSyncService.js:10` creates `LLT_OFFLINE` storage through this provider.
- `services/offlineSyncService.js:16-21` stores queue and processed action state.
- `services/offlineSyncService.js:200-201` stores `tour_pack_*` and `tour_pack_meta_*` data.
- `__tests__/persistenceProvider.test.js:16-37` currently asserts native-like runtime selects SecureStore.

What is happening:

The shared persistence provider prefers Expo SecureStore in native runtime, regardless of namespace. The offline sync service then uses that provider for large operational data: queue state, tour packs, booking/tour cache, and metadata. If the active adapter throws, the provider logs and switches to `memory-mock`.

Why this blocks publish:

SecureStore is not the right default for large offline packs or growing queue payloads. If a write fails because a payload is too large or the secure storage backend rejects it, the provider can silently switch to memory. After that, queued work, offline tour data, or diagnostics can appear to work during the current session but disappear on app restart.

This undermines core launch promises: offline recovery, queued chat/photo/manifest work, and reliable diagnostics.

Expected fix:

- Add an explicit storage policy to `createPersistenceProvider`, such as `preferredStorage: 'async-storage' | 'secure-store' | 'memory'`.
- Use AsyncStorage or a larger durable store for `LLT_OFFLINE`, logs, chat drafts/read state, content moderation cache, and crash diagnostics.
- Reserve SecureStore for small secrets only.
- For durable namespaces, do not silently fall back to memory. Return an error or mark storage degraded so the UI and logs can surface the problem.
- Keep memory fallback only for tests or explicitly non-durable runtime data.

Verification:

- Update tests so `LLT_OFFLINE` in a native-like runtime selects AsyncStorage or the chosen large durable adapter.
- Add a test where SecureStore throws on a large write and the offline queue does not become memory-only.
- Add a test for user-visible or logger-visible storage degradation.
- Re-run `npm run test:mobile`.
- On a physical device, cache a tour pack, kill/restart the app, and confirm offline login/tour recovery still works.

### B4. Production dependency audits currently fail

Evidence:

- `npm audit --omit=dev` failed on 2026-06-11.
- `npm ls shell-quote --omit=dev` shows `react-native@0.83.6 -> react-devtools-core@6.1.5 -> shell-quote@1.8.3`.
- `npm --prefix functions audit --omit=dev` failed on 2026-06-11.
- `npm --prefix functions ls @grpc/grpc-js --omit=dev` shows `firebase-admin@13.10.0 -> @google-cloud/firestore@7.11.6 -> google-gax@4.6.1 -> @grpc/grpc-js@1.14.1`.

What is happening:

The app dependency tree currently has one critical advisory in `shell-quote`. The Functions dependency tree currently has one high-severity advisory in `@grpc/grpc-js`.

Why this blocks publish:

Even if the root advisory is likely in a development/devtools path, a critical production audit failure needs to be fixed or explicitly documented as a non-runtime false positive before release. The Functions advisory is in the deployed backend dependency tree and should be fixed before deploying production Functions.

Expected fix:

- Run the appropriate lockfile update or `npm audit fix` in the app root and in `functions`.
- If needed, add a targeted `overrides` entry for the patched transitive package version, then run install and tests.
- For Functions, ensure `@grpc/grpc-js` resolves to a patched version before deployment.
- Commit the resulting `package-lock.json` and `functions/package-lock.json` changes.

Verification:

- `npm audit --omit=dev` exits 0 or has a documented release exception approved by the team.
- `npm --prefix functions audit --omit=dev` exits 0.
- Re-run:
  - `npm run test:mobile`
  - `npm run test:functions:scripts`
  - `npm run test:emulators`
  - `npx expo-doctor`

### B5. Production environment and backend deployment gates are not closed

Evidence:

- `scripts/validateExpoPublicEnv.js:19-83`
- `app.config.js:1-2`
- `app.config.js:74-77`
- `eas.json:46-57`
- `dependency-upgrade-prod-readiness.md`
- Current validation result: `npm run validate:expo-env` failed locally without exported env vars, and failed with `.env.local` because `EXPO_PUBLIC_SUPPORT_PHONE` is still placeholder-like.

What is happening:

The app depends on production Firebase public config, Android Google Maps key, support/privacy fields, deployed Cloud Functions, deployed Realtime Database rules, and deployed Storage rules. The workflows are set up for this, but the validation command must pass with the actual production EAS/CI environment before building or updating production.

Why this blocks publish:

Missing Firebase env prevents Firebase initialization. Missing Android Google Maps API key breaks Android map behavior because `app.config.js` inserts an empty key when the env var is absent. A placeholder support phone can produce broken in-app support paths or fail release validation. Missing deployed Functions can break passenger login, driver login, and manifest access.

Expected fix:

- Populate production EAS/CI env with real values for all required `EXPO_PUBLIC_FIREBASE_*` variables and `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY`.
- Set a real `EXPO_PUBLIC_SUPPORT_PHONE` or remove the optional variable if support phone should not be exposed.
- Confirm privacy URL, support SMS/email, App Check flags, and verifier URLs are correct for production.
- Deploy Cloud Functions before the app build/update, especially:
  - `verifyPassengerLogin`
  - `verifyDriverLogin`
  - `getTourManifest`
- Deploy Realtime Database rules and Storage rules after function compatibility is confirmed.
- Verify the EAS remote app version state because `eas.json:2-6` uses remote app version source.

Verification:

- `npm run validate:expo-env` passes in the same shell/environment used by production EAS.
- `npm run sync:eas-env:production` succeeds without unresolved aliases.
- `npm run test:emulators` passes after any rules change.
- A production-channel TestFlight/internal build can log in as passenger and driver against deployed production backend.

### B6. App Review and physical-device release gates remain open

Evidence:

- `docs/apple-app-review-readiness-checklist.md:44-54`
- `docs/apple-app-review-readiness-checklist.md:56-61`
- `docs/apple-app-review-readiness-checklist.md:102-110`
- `docs/apple-app-review-readiness-checklist.md:112-120`
- `docs/apple-app-review-readiness-checklist.md:257-287`
- `docs/apple-app-review-readiness-checklist.md:289-316`
- `app.config.js:40-43` sets `ios.supportsTablet: true`.

What is happening:

The repo has a good App Review checklist, but several boxes remain unchecked: final App Privacy Label sign-off, mobile-app-specific privacy policy hosted at the configured HTTPS URL, archive privacy report review, live stable reviewer backend data, real iPhone/iPad TestFlight testing, and App Store Connect metadata.

Why this blocks publish:

These are not optional for first submission. Because `supportsTablet` is true, Apple can review the iPad experience. If the app is not verified on iPad, either test and support it or disable tablet support before submission.

Expected fix:

- Host the mobile-specific privacy policy PDF at the configured public HTTPS URL.
- Ensure the in-app Account & privacy link and App Store Connect privacy policy URL point to that same policy.
- Generate and review the iOS archive privacy report.
- Cross-check SDK privacy manifests, required-reason API declarations, and App Privacy Nutrition Label answers.
- Seed and freeze stable reviewer passenger and driver data for the entire review window.
- Test the exact production/TestFlight build on real iPhone and real iPad, or set `ios.supportsTablet: false` before submission if iPad is not supported.
- Fill App Store Connect metadata, screenshots, review contact, review notes, demo credentials, export compliance, content rights, pricing, age rating, and privacy responses.

Verification:

- Every unchecked item in `docs/apple-app-review-readiness-checklist.md` that is under "Non-Negotiable First-Submission Blockers" and "Release Readiness Sign-Off" is checked.
- Reviewer credentials are pasted into App Store Connect and tested on the exact uploaded build.
- Physical-device checklist is completed for the exact build.

## Not Blockers, But Fix Within The First Month

### M1. Storage object reads for private and group photos are too broad

Evidence:

- `storage_rules.json:20-35`
- Stricter metadata rules exist in `database.rules.json:215-249`.

Current behavior:

Realtime Database metadata access is scoped to participants, assigned drivers, admins, or private owner identity bindings. Storage object reads, however, allow any signed-in user to read `private_tour_photos/**` and `group_tour_photos/**` if they know or obtain the object path/download URL.

Why it matters:

This is better than public storage, but it is still broader than the metadata privacy model. Private photo objects are especially sensitive.

Fix direction:

- Move private photo delivery behind signed, short-lived server URLs or a function that verifies the RTDB metadata permissions first.
- Alternatively redesign storage paths and auth claims so Storage rules can enforce owner/tour membership directly.
- Review Firebase Storage download-token behavior and ensure tokens are rotated or avoided where privacy requires it.

Verification:

- Add Storage rules or service tests proving a signed-in outsider cannot fetch another passenger's private object.
- Confirm group photo access still works for tour participants and assigned drivers.

### M2. `currentParticipants` is participant-writable

Evidence:

- `database.rules.json:76-78`
- `services/bookingServiceRealtime.js` reconciles participant count after join.
- `tests/joinTour.test.js` covers the current behavior.

Current behavior:

Any tour participant can write `tours/$tourId/currentParticipants` as long as the number is within bounds.

Why it matters:

The field is denormalized state. Letting regular clients write it can produce incorrect capacity counts or misleading operations data if a client is buggy or malicious.

Fix direction:

- Move participant count reconciliation to a Cloud Function or admin-only process.
- Let clients write only their own participant row.
- Keep `currentParticipants` server-owned.

Verification:

- Rules test proves participants cannot directly write `currentParticipants`.
- Join flow still updates counts through the server path.

### M3. Photo upload idempotency scans the whole album branch

Evidence:

- `services/photoService.js:815-826`

Current behavior:

When an `idempotencyKey` is present, upload logic reads the whole photo metadata branch and scans entries for a matching key.

Why it matters:

This is acceptable for small albums, but it becomes expensive and slow for busy launch tours with many uploads.

Fix direction:

- Add an idempotency index such as `photo_upload_idempotency/{tourId}/{visibility}/{ownerKey}/{idempotencyKey}`.
- Or generate deterministic photo IDs from a bounded idempotency key and identity scope.
- Avoid full-branch reads before upload.

Verification:

- Add tests proving retry lookup reads only the idempotency pointer or deterministic record.
- Load test uploads for a tour with hundreds or thousands of photo records.

### M4. Offline queues and tour packs need global size and age caps

Evidence:

- `services/offlineSyncService.js:16-21`
- `services/offlineSyncService.js:200-201`
- `services/safetyService.js` keeps a separate safety offline queue.

Current behavior:

Photo completion records have pruning, but there is no global max item count, byte budget, tour-pack age policy, or unified durable queue policy across all offline work.

Why it matters:

At launch scale, users can accumulate stale packs, failed actions, photo jobs, and safety events. Without caps, local storage pressure becomes unpredictable and can trigger the persistence failure mode described in B3.

Fix direction:

- Define max queue items, max serialized bytes, and max tour-pack age.
- Evict stale packs and old terminal queue entries.
- Unify the safety queue with the main durable queue or give it equivalent caps/retry metadata.
- Surface "storage full/degraded" to the user when durable offline work cannot be saved.

Verification:

- Tests for queue byte caps, age eviction, stale pack eviction, and degraded-storage UI/logging.
- Physical-device test with intentionally large cached data.

### M5. Safety alert schemas and rate limits are minimal

Evidence:

- `database.rules.json:114-118`
- `database.rules.json:461-466`
- `services/safetyService.js:156-171`, `services/safetyService.js:264-319`, `services/safetyService.js:383-432`

Current behavior:

Tour safety alerts require only timestamp, status, and userId. Global safety alerts are similarly minimal. There is no obvious per-user rate limit at the rules level.

Why it matters:

Safety reporting is operationally important and high-signal. Bad data, repeated spam, or malformed records can create noise during incidents.

Fix direction:

- Add stricter schema validation: status enum, message length, optional coordinate bounds, event type enum, and identity matching.
- Add per-user throttling through a function or server-owned write path.
- Add ops alerting and dashboard thresholds for repeated safety events.

Verification:

- Rules tests for malformed safety alerts, excessive text, invalid coordinates, and wrong user IDs.
- Function/service tests for rate limiting and alert creation.

### M6. Notification fanout is capped at 1,000 recipients

Evidence:

- `functions/index.js:22`
- `functions/index.js:1616-1635`
- `functions/index.js:1750-1763`

Current behavior:

Recipient fetch and fanout paths cap recipient candidates at 1,000. The function logs when the category broadcast preference query exceeds the cap.

Why it matters:

This is fine for tour-scoped operational messages if tours stay well below that size, but it is not a broad marketing/category broadcast architecture for thousands of opted-in users.

Fix direction:

- Keep tour chat and itinerary notifications scoped and capped.
- For category broadcasts, use paginated fanout jobs, Cloud Tasks, scheduled continuation records, or another durable batch system.
- Track send receipts and retry/cleanup invalid tokens beyond immediate ticket errors.

Verification:

- Tests for broadcast continuation across more than 1,000 recipients.
- A dry-run job that reports total eligible, sent, skipped, failed, and continuation state.

### M7. Account deletion is client-orchestrated

Evidence:

- `services/accountDeletionService.js:318-455`

Current behavior:

The client deletes owned photos, private photos, app records, chat scrub records, local stores, and the Firebase Auth user in sequence.

Why it matters:

The implementation is careful and tested, but client-orchestrated deletion can partially fail on bad networks or app termination. That is a compliance and support risk.

Fix direction:

- Move deletion to an idempotent server-side workflow.
- Create a deletion request/status record.
- Let the server scrub remote records and storage objects with retry.
- Let the client clear local data and poll or subscribe to deletion status.

Verification:

- Tests proving repeated deletion requests are safe.
- Tests proving partial failures resume.
- Device test with network interruption during deletion.

### M8. UGC moderation needs an operational SLA outside the mobile code

Evidence:

- `services/contentModerationService.js`
- `database.rules.json:373-380`
- `docs/apple-app-review-readiness-checklist.md:160-167`

Current behavior:

Repo-side mobile reporting/filtering exists for chat and group photos. Reports are stored under `content_reports`. The checklist says web-admin has a moderation queue, but `web-admin` was excluded from this review.

Why it matters:

Apple expects timely response to objectionable-content reports. Having a record path is not enough if no one owns the queue after launch.

Fix direction:

- Assign an operations owner and response SLA.
- Verify web-admin moderation queue separately.
- Add alerting for new `content_reports`.
- Add audit fields for actioned/dismissed reports.

Verification:

- End-to-end report from TestFlight appears in the moderation queue.
- Moderator action removes or tombstones content and updates report status.
- Alerting fires for a new open report.

### M9. Chat image captions do not use the same moderation assertion as text messages

Evidence:

- `services/chatService.js:747-770`
- Text messages use `assertTextPassesModeration` earlier in `services/chatService.js`.
- Photo captions in `services/photoService.js:607-619` do run through caption moderation.

Current behavior:

`sendImageMessage` sanitizes and length-checks captions but does not call `assertTextPassesModeration`. Current UI appears to send image messages without captions, so this is not an immediate publish blocker unless captions are enabled.

Why it matters:

If chat image captions become user-editable, objectionable text can bypass the chat text moderation path.

Fix direction:

- Call `assertTextPassesModeration(sanitizedCaption, 'Caption')` for non-empty chat image captions.
- Add tests mirroring text message moderation tests.

Verification:

- Unit test proves offensive chat image captions are rejected.
- Unit test proves normal captions still send.

### M10. The operations admin UID is hard-coded

Evidence:

- `functions/index.js:31`
- Repeated hard-coded UID checks in `database.rules.json`.

Current behavior:

One UID is treated as the operations admin across Functions and rules.

Why it matters:

This is workable for bootstrap, but it is hard to rotate, audit, or delegate safely after launch.

Fix direction:

- Prefer custom claims, `admin_users`, or another role-managed model.
- Document emergency admin rotation.
- Remove direct UID duplication where possible.

Verification:

- Tests proving role-managed admins can perform admin actions.
- Tests proving removed admins lose access.

### M11. App Check support exists but is not enforced by default

Evidence:

- `functions/index.js:1290-1300`
- App env flags in `.env.example` and `scripts/validateExpoPublicEnv.js`.

Current behavior:

The login verifier can require App Check when configured, but enforcement is controlled by environment flags and is not guaranteed by default.

Why it matters:

After production mobile apps are registered and verified, App Check gives useful abuse protection for login endpoints and Firebase backend access.

Fix direction:

- Register production iOS and Android apps with App Check.
- Enable App Check on login endpoints after smoke testing.
- Evaluate RTDB and Storage App Check enforcement after confirming all clients are on supported builds.

Verification:

- Real production build sends App Check token.
- Login fails without App Check when enforcement is enabled.
- Login succeeds on current App Store/TestFlight build.

### M12. Diagnostics and logs need retention, sampling, and alert thresholds

Evidence:

- `services/loggerService.js`
- `services/crashDiagnosticsService.js`
- `services/loginDiagnosticsService.js`
- `docs/data-contracts/ops-alerts.md`

Current behavior:

The app has substantial redaction and `ops_alerts` support, but raw diagnostics can still grow quickly after launch. B1 must be fixed first.

Why it matters:

Thousands of new users can produce high diagnostic volume. Without retention and sampling, this can become expensive and noisy.

Fix direction:

- Add retention policy for `/logs`.
- Add sampling or severity thresholds for remote diagnostics.
- Add dashboards and alert thresholds for `ops_alerts`.
- Keep raw `/logs` out of browser dashboards, as the existing docs already recommend.

Verification:

- Scheduled cleanup or TTL policy is active.
- Ops dashboard uses bounded `ops_alerts` queries.
- Alert thresholds are documented and tested.

## Release Order After Fixing Blockers

1. Fix B1 through B4 in code and lockfiles.
2. Re-run `npm run test:mobile`, `npm run test:functions:scripts`, `npm run test:emulators`, `npm audit --omit=dev`, `npm --prefix functions audit --omit=dev`, and `npx expo-doctor`.
3. Load the real production environment and run `npm run validate:expo-env`.
4. Deploy Cloud Functions.
5. Deploy Realtime Database rules.
6. Deploy Storage rules.
7. Build the production EAS binary from the exact commit that passed validation.
8. Test passenger and driver login on the deployed backend.
9. Complete the physical iPhone/iPad checklist or disable iPad support.
10. Complete App Store Connect metadata, privacy, credentials, and review notes.
11. Submit for review.

## Final Readiness Definition

The app is publish-ready when:

- Every absolute blocker in this document is closed.
- All validation commands pass with the production environment loaded.
- Production Functions, Realtime Database rules, and Storage rules are deployed from the reviewed commit.
- The exact uploaded build passes the physical-device checklist.
- App Review privacy, metadata, screenshots, review credentials, and policy URLs are complete and consistent.

At that point, the remaining first-month items can be tracked as post-launch hardening rather than release blockers.
