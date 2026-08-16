# Mobile App Reliability and Security Upgrade Audit

Date: 12 August 2026
Release contract: `1.0.3`
Firebase project: `loch-lomond-travel`

## Outcome

This pass upgraded the passenger and driver app across authentication, durable local state, offline replay, safety reporting, photo upload scale, diagnostics privacy, crash recovery, backend rate limiting, dependency compatibility, and release validation. The associated Cloud Functions and Realtime Database rules/indexes were deployed after their automated gates passed. No EAS update or store binary was published.

The second improvement pass completed three additional end-to-end targets: actionable notifications, conflict-safe itinerary/Tour Pack state, and race-safe driver manifest reconciliation. It also found and fixed a web-startup crash in runtime detection while performing rendered QA.

The closure pass made driver identity and assignment server-owned. Driver verification now
claims an unclaimed roster entry transactionally, and mobile self-assignment runs through an
authenticated, rate-limited Function that serializes competing driver/tour mutations and
writes every canonical link atomically. Realtime Database rules prevent clients from claiming
drivers, changing profile authority fields, or manufacturing manifest assignment access.
Invalid Expo push-token cleanup is awaited before notification Functions finish, so cleanup
cannot be abandoned when an invocation exits.

## Three-target improvement pass

### Actionable notification delivery

- Admin broadcasts and itinerary changes now persist a bounded, idempotent `tour_notifications` history before push delivery, so notices remain available after a push is dismissed or a device was offline.
- Notification taps use one validated route contract for cold starts and foreground/background responses, reject notices for another tour, deduplicate deliveries, mark notices read, and open the relevant app screen.
- The preferences screen now contains a live recent-updates inbox with unread state and mark-one/mark-all actions. Realtime Database rules allow only tour participants, assigned drivers, and admins to read the feed; clients cannot forge notices.
- Follow-up verification repaired the complete tap-through contract: push payloads retain durable notice and exact chat-message IDs, messages outside the live window are fetched directly, marketing taps expand the promised category, navigation failures can retry, and global preference routing remains gated behind a restored app session.

### Find My Bus location integrity

- Driver location now has a strict versioned schema with server timestamps and explicit fixed-pickup versus live-sharing modes.
- Passenger location permission is optional: the shared driver point renders without prompting, while distance and travel estimates activate only when the passenger chooses their own-location control.
- Live points age in place, lose directions when stale, and disappear after 30 minutes. Snapshot removal clears the old marker immediately.
- Stopping auto-share safely withdraws live state without deleting a manual pickup point, and assignment changes clear previous-driver location state atomically.

### Itinerary and Tour Pack integrity

- Driver edits now use a Realtime Database transaction with a canonical content signature. A stale editor cannot silently overwrite a newer itinerary; the exact server version is retained and presented for review.
- Successful itinerary writes carry a monotonic revision plus `updatedAt` and `updatedBy`, with matching database validation. Remote deletion clears both live state and the cached Tour Pack tombstone instead of resurrecting stale content.
- Partial Tour Pack saves are serialized per tour/role, preventing concurrent itinerary and driver-itinerary writes from clobbering each other. Driver itinerary data uses the identity-scoped Tour Pack; old unscoped cache entries are deleted without being shown or migrated to a different signed-in driver.

### Account deletion privacy and recovery

- Deleted chat messages now clear retained image and thumbnail download URLs as well as their text before the app account is removed.
- Local provider failures are counted as cleanup warnings instead of successful deletion steps, including compatibility providers that report failure with a `false` result.
- Backend exception details are logged for operations but mapped to curated connection, authorization, or safe generic copy on the account screen.

### Mobile bundle efficiency

- Every screen and shared component imports Material Community Icons from its direct module instead of the `@expo/vector-icons` barrel. The Android production export dropped from 921 to 867 modules, from 21 to 3 emitted assets, and from a 6.2 MB to a 6.0 MB Hermes bundle while removing 18 unused font files.

### Photo deletion integrity

- Storage rules now distinguish an owner upload/update from an owner delete; deletes no longer fail merely because a delete request has no `request.resource` image body.
- Group and private photo deletion removes every known Storage variant before the RTDB record. Transient Storage failures leave the record available for retry, while an already-missing object is treated as an idempotent success.
- The emulator gate now runs both Realtime Database and Storage rules. Its 86 checks cover identity anti-forgery, driver assignment escalation denial, admin-role escalation denial, owner delete, foreign overwrite/delete denial, uploader metadata, image-only uploads, and authenticated reads.

### Driver manifest reconciliation

- Manifest status writes now run in a database transaction. Server-newer data is preserved and returned exactly, while idempotent replay of the same action is a safe no-op.
- The offline queue supersedes stale actions only for the same canonical tour and booking, and replay returns structured reconciliation outcomes before removing completed actions.
- The manifest screen subscribes to live, tour-scoped queue state; queued updates remain visible optimistically, other tours cannot pollute its counters, and a protected server state appears in an explicit conflict card with review/dismiss actions.

## High-impact defects corrected

### Authentication and privacy

- Passenger login throttling now uses separate hashed credential, authenticated-account, and broad network dimensions. One shared network can no longer exhaust the normal credential limit for every traveller.
- Passenger identity profiles and new identity bindings must match the caller's canonical short-lived verified-login grant; authenticated clients can no longer bind themselves to an arbitrary passenger principal.
- App logout deactivates the device push token even though Firebase anonymous authentication remains active, always clears the in-memory session if durable cleanup fails, and silently restores the token after the next successful login without changing preferences or prompting again.
- Remote diagnostic, crash, login, and safety logs require an authenticated identity. Anonymous sessions remain local and cannot write to `/logs`.
- Chat image captions now pass through the same moderation path as text messages.

### Durable offline behaviour

- Tour Packs, offline actions, safety events, diagnostics, and account-deletion state use durable AsyncStorage rather than silently degrading to process memory.
- Legacy SecureStore values can migrate forward without permitting a non-durable production fallback.
- The browser adapter is explicitly recognised as durable through AsyncStorage's localStorage implementation.
- Offline actions are capped at 500, corrupt payloads are backed up, and a transient read failure cannot be mistaken for an empty queue and overwrite pending work.
- Safety retries are capped at 250 and retain critical/SOS events preferentially. The UI distinguishes a remotely submitted report from one saved for retry and never reports a queue success after persistence failure.

### Data integrity and scale

- Passenger login/join no longer overwrites the admin/booked `currentParticipants` total with app-membership size. The database rule makes this field admin-owned.
- Photo idempotency lookup is an indexed exact query rather than a whole-album scan. New idempotent uploads use deterministic database keys while remaining compatible with legacy push-key records.
- Photo Functions use the current patched Sharp dependency, and Functions production dependencies audit cleanly.

### Chat delivery integrity pass

- Text, internal-driver, and photo chat sends now use a deterministic message path with create-once transactions. Offline replay and manual retry preserve the same identity, preventing duplicate messages after ambiguous network acknowledgements.
- Versioned messages use server timestamps and bounded immutable delivery fields; legacy installed clients remain accepted during rollout.
- Captionless photos now generate useful notifications, assigned drivers receive group-chat notifications, and internal driver chat notifies the other assigned drivers with exact-message routing.
- Photo retries reuse both upload and message idempotency keys, avoiding duplicate gallery records when chat delivery is retried.

### Recovery and release safety

- App startup now cleans up its authentication listener, exposes an initialization retry, and has a top-level recovery boundary with a remount path after an unexpected render failure.
- Production session state cannot silently fall back to an in-memory mock.
- Expo SDK 55 packages were aligned to their compatible patch releases; Functions use the documented Node.js 22 runtime.
- The native-module change is isolated as app version `1.0.3`. With `runtimeVersion.policy = appVersion`, a 1.0.3 OTA cannot be sent to a 1.0.2 binary accidentally.
- The direct environment validator now loads Expo-compatible `.env.local` files without printing public configuration values, matching the Expo CLI and CI/EAS behaviour.

## Verification evidence

- `npm run test:all`: passed the complete mobile, web-admin, and Functions script matrix.
- Authentication suite: 54 passed.
- Booking/data-integrity suite: 17 passed.
- Offline/persistence suite: 45 passed after queue, Tour Pack serialization, and web-durability coverage.
- Chat suite: 43 passed.
- Photo suite: 47 passed.
- Notification service/inbox suite: 15 passed.
- Itinerary transaction suite: 4 passed.
- Booking/manifest reconciliation suite: 20 passed.
- Functions suite: 50 passed, including server-owned driver assignment, awaited invalid-token cleanup, durable notification history, retry-safe deletion, CORS, and itinerary diff coverage.
- Firebase RTDB and Storage rules emulator: 86 passed, 0 failed across 13 rule suites.
- Expo Doctor: 19/19 checks passed.
- `npm run validate:expo-env`: passed for all platforms.
- Cleared-cache Android production export: 866 modules, 3 assets, and a 6 MB Hermes bundle.
- Rendered browser QA at the default desktop viewport and 390x844: the app rendered cleanly, driver/passenger mode switching and the sign-in help disclosure worked, and the final reload produced no console errors. The pass found and fixed an actual blank-page web crash caused by probing a React Native bridge accessor before detecting the browser, and removed the unsupported web auth-persistence call.
- Post-deploy inventory: all 12 Gen 2 Functions report `nodejs22`.
- Post-deploy HTTP smoke: `verifyPassengerLogin` returned `401` for a correctly shaped unauthenticated request.
- Post-deploy driver HTTP smoke: both `verifyDriverLogin` and `assignDriverToTour`
  returned `401` for unauthenticated POST requests, confirming the endpoints are active and
  preserve their authentication boundary without mutating production data.
- Post-deploy admin Function smoke: the deployed portal origin received CORS `204`, an untrusted origin received `403`, and an unauthenticated mutation received `401`.
- Post-deploy portal smoke: all six authenticated routes rendered live Firebase data with no console warning/error; SPA documents were non-cacheable, hashed assets were immutable, CSP was present, and framing was denied.
- Post-deploy rules smoke: unauthenticated `/logs` read returned `401`.
- Root and Functions `git diff --check`: no whitespace errors at the audit gate.

## Production deployment

- All 12 Cloud Functions updated successfully on Node.js 22.
- Realtime Database rules and indexes validated and released successfully.
- Storage rules and the rebuilt Firebase Hosting portal released successfully.
- Web-admin and Functions production dependency audits: 0 vulnerabilities.
- Functions production audit: 0 vulnerabilities.
- No mobile OTA, EAS build, TestFlight upload, Play Console upload, or store release was performed. Version 1.0.3 therefore still requires a signed device build and release workflow.
- EAS authentication and project linkage were verified. The newest completed production binary is iOS `1.0.2` build `7`; no `1.0.3` build exists yet. Android remote version state is not initialized, so its Play Console version code must be confirmed before the first 1.0.3 production build.
- The local `outputs/` artifact directory is ignored from Git/EAS packaging so unrelated generated files cannot enter a mobile build upload.

## Remaining release gates and accepted risks

1. A physical iOS and Android pass is still required for camera/photo permissions, saved-media permission, maps/location, background/terminated notification delivery, deep links, poor-network replay, and SOS/support handoff. These cannot be proven by Node tests or a web renderer.
2. App Check remains disabled by default. Enabling enforcement requires a staged rollout with registered production builds so valid travellers are not locked out.
3. The root production audit reports 11 high findings in one Metro `image-size` build-time dependency chain. The upstream advisories currently list no patched `image-size` release, and npm's suggested fix downgrades Expo 55/React Native 0.83 to incompatible older versions. The parser is used by the build toolchain, not the app's runtime upload path; do not process untrusted ICNS/JXL/HEIF assets during builds.
4. Authenticated Storage reads and long-lived Firebase download-token URLs remain a broader privacy architecture concern. Moving sensitive media behind short-lived, server-authorised delivery should be handled as a separate migration.
5. Account deletion still depends on Firebase client/account lifecycle constraints and should receive a real-device, real-account end-to-end exercise before the next store submission.
6. The repository contains the audited release as uncommitted working-tree changes. Create a traceable release commit on `main` before invoking the existing production EAS workflow; do not build a store candidate from an uncommitted archive.

## Release recommendation

Build 1.0.3 as a new signed preview binary, complete the physical-device matrix above, then promote the same native build to production. Do not publish these native-module changes as an OTA to 1.0.2.
