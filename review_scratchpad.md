# LLT App Release Review Scratchpad

Scope: `llt-app-new`, excluding `web-admin`.

Review date: 2026-06-11.

## Scope decisions

- Reviewed owned source, app config, EAS/release metadata, Firebase Realtime Database rules, Storage rules, Cloud Functions, mobile services, screens, hooks, utilities, tests, and release docs.
- Excluded generated/vendor/local output from detailed review: `.git`, `.expo`, root `node_modules`, `functions/node_modules`, Android Gradle/CMake/build output, and debug log files.
- `web-admin` is explicitly out of scope. Some shared contracts and docs reference it, but its implementation was not reviewed.

## Confirmed blocker candidates

### Unauthenticated `/logs/anonymous/**` writes

- Evidence: `database.rules.json` allows `$userId === 'anonymous'` to write under `/logs/anonymous/**` without `auth`.
- Related writers: `services/loginDiagnosticsService.js`, `services/loggerService.js`, `services/crashDiagnosticsService.js`, `services/safetyService.js`.
- Risk: public Firebase config plus unauthenticated, unbounded writes creates a launch-scale cost/DoS/data-pollution vector.
- Expected fix: require auth or move anonymous diagnostics behind a rate-limited function; add schema and size validation; add emulator rules tests.

### Passenger login verifier rate limit can block legitimate launch bursts

- Evidence: `functions/index.js` applies `checkRateLimit("verify_passenger_login_${clientKey}", 12, 60000)` before token verification, where `clientKey` is derived from IP plus client ID/user-agent.
- Client impact: `services/bookingServiceRealtime.js` maps the function response to a visible "too many attempts" login failure.
- Risk: many real passengers behind one hotel/coach/carrier NAT can share IP and native user-agent, so a launch cohort can lock itself out.
- Expected fix: authenticate first, then rate limit by auth uid plus booking/email hash plus IP, with a burst suitable for initial onboarding.

### Durable offline data currently prefers SecureStore and can fall back to memory

- Evidence: `services/persistenceProvider.js` prefers SecureStore for native runtimes. `services/offlineSyncService.js` stores queue and tour packs through this provider.
- Risk: SecureStore is unsuitable for large tour packs/queues. Provider errors switch the active adapter to memory, making offline queue/cache/log data non-durable until restart.
- Expected fix: use AsyncStorage or another large durable store for offline/cache/log namespaces; reserve SecureStore for small secrets; do not silently memory-fallback for durable namespaces.

### Release/App Review operational gates remain hard blockers

- Evidence: `dependency-upgrade-prod-readiness.md`, `docs/apple-app-review-readiness-checklist.md`, app config, workflows.
- Required before publish: production env validation, deploy functions/rules/storage in correct order, emulator tests, stable reviewer demo data, privacy policy URL, App Privacy Label/archive privacy report cross-check, physical iPhone and iPad TestFlight verification or disabling tablet support.

## First-month candidates

- Storage object reads for private/group photos are signed-in-wide in `storage_rules.json`; metadata is stricter but direct object access should be hardened.
- `tours/$tourId/currentParticipants` is participant-writable in `database.rules.json`; make it server-reconciled.
- Photo upload idempotency scans the whole album branch in `services/photoService.js`; replace with deterministic/idempotency-index lookup.
- Offline queues/tour packs need global size/age caps and a unified durable queue policy.
- Safety alert/log schemas and rate limits are minimal; tighten validation and add ops alerting.
- Notification fanout is capped at 1,000 recipients in `functions/index.js`; build paginated/batched fanout before broader broadcast use.
- Account deletion is client-orchestrated; move to an idempotent server-side deletion workflow.
- UGC moderation has code paths, but needs a documented ops owner/SLA/alerting loop for App Review scale.
- Image captions currently do not go through the same moderation assertion as chat text before future caption support is enabled.
- Hard-coded admin UID should move to custom claims/role-managed configuration.
- App Check support exists but is not enforced by default; enable after production apps are registered and verified.
- Custom diagnostics need retention, quota, sampling, dashboards, and alert thresholds after launch.

## Validation commands

- Passed: `npm run test:mobile`
- Passed: `npm run test:functions:scripts`
- Passed: `npm run test:emulators` with Java 21
- Passed: `npx expo-doctor` after Expo loaded `.env.local`; 19/19 checks passed
- Failed as expected without exported env: `npm run validate:expo-env` reported missing required Firebase and Google Maps public variables
- Failed with `.env.local` explicitly loaded: `npm run validate:expo-env` reported `EXPO_PUBLIC_SUPPORT_PHONE` still looks like a placeholder or unresolved EAS alias
- Failed: `npm audit --omit=dev` reported one critical advisory for `shell-quote@1.8.3` via `react-native -> react-devtools-core`
- Failed: `npm --prefix functions audit --omit=dev` reported one high advisory for `@grpc/grpc-js@1.14.1` via `firebase-admin -> @google-cloud/firestore -> google-gax`
