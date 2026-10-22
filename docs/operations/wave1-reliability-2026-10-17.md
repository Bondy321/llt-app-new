# Wave 1 reliability implementation — 17 October 2026

Audit reference: `daec49e56b9042e6ca24a1d879e44f7226f6e20f`.
The implementation started from that exact clean main revision, without resetting
or discarding user work. This document describes repository changes; a merge is
not evidence of a Firebase deployment or an installed mobile update.

**Sign-off correction:** the independent review found four blocking interactions
in this revision. Its original test totals below are historical evidence, not
source acceptance. See [the correction record](./wave1-signoff-corrections-2026-10-22.md)
for W1R-01 through W1R-04, current evidence and the explicit deployment overlap
condition. F04 has narrow cold-cache acceptance; it does not establish general
notification attempt/count/queue correctness.

## Findings and evidence

| Finding | Repair | Regression evidence |
| --- | --- | --- |
| F01 | Same-installation, same-session, same-principal driver transitions reconcile monotonically through the session adapter and application runner. Storage, booking/tour, expiry timer and service generation follow the accepted authority. Old tour replay, listeners and tracking retire before new scope work. | Actual listener/application tests cover first assignment, reassignment/removal, both event orderings, stale/duplicate replies, changed principals/sessions, renewed expiry, persisted projections, retirement failure and old scope work. Original implementation failed the baseline regressions. |
| F04 | Existing-record transactions distinguish a cold null callback from authoritative absence and use final accepted callback plus committed result. Claims, progress, retry, release and finalisation preserve exact owners and retention barriers. | Separate fresh Admin apps, no retained listeners: notification fanout→retry→receipt and account deletion through actual Auth deletion, absent/future/leased records, stale owners, manual retry and duplicate invocation. Five genuine original failures reproduced. |
| F05 | Each acquisition uses a current clock. Session revision and absolute lease expiry are compared in bounded canonical transactions at ending/removal. Derived leaves compare exact session ownership; replacement issuance writes ownership tags. Partial cleanup retains ending retry scope; audit persistence precedes final deletion. | Controlled 31-second batch delay, expired in-flight cleanup, real passenger/driver replacement issuance, stale policy cleanup, preserved membership/notification/live authority, idempotent retry and audit failure recovery. Actual SDK tests use synthetic local demo data. |
| F06 | Login-specific admission accepts an unclaimed driver into the existing serial reservation. Strict established binding remains required by notifications and other authorised consumers. Real policy transitions/admissions also handle cold SDK callbacks. | Normal enable/claim cleanup→first handset, second handset denial, concurrent first handsets with exactly one winner, same UID, new code, enforcement off and policy-drain interleaving. Original enforced first claim returned 403 before the admission fix. |

The combined real-SDK test enables enforcement, logs in an unclaimed driver,
applies an actual realtime assignment event before releasing the HTTP response,
asserts the signed-in application/storage scope and notification eligibility,
then issues a replacement login and rejects obsolete policy cleanup.

## Compatibility and boundaries

- Canonical client session shape is unchanged. No new native dependency,
  permission, runtime fingerprint or binary is required for F01; it needs mobile
  JavaScript delivery and device acceptance. Existing binaries accept revision
  changes without an unknown field being introduced.
- Server-owned ownership tags are `users/{uid}/appSessionId`, grant `sessionId`
  and notification-device `authoritySessionId`. Rules prevent client creation,
  editing or parent-update removal of the profile tag. Existing compatible
  whole-profile deletion remains supported and creates no authority.
- Routine notification registration, location pickup, tracking Stop and role
  claim cleanup acquire distinct non-revision-advancing lock operations. Session
  issuance, assignment and termination advance the bounded revision fence.
- Passenger multi-phone membership and device-local logout remain intact.
  Deletion scope, sibling authority, retained operational records, tombstones,
  notification eligibility/deduplication and tracking stop fences are preserved.
- Assignment never relabels old queued actions or GPS samples, nor silently
  starts a tracking session for the new tour.
- No live feature flag or maintenance job is changed by these tests. App Check
  remains explicitly disabled; Command Centre remains limited; notification
  retention scheduling must remain paused.

## Verification record

Commands run sequentially with `TZ=Europe/London`; Node test file concurrency is
at most two, new SDK emulator suites one. External providers are stubbed, actual
RTDB/Auth transaction behaviour is retained. All emulator writes require
loopback endpoints and explicit `demo-*` project IDs. Logs are under the sibling
workspace directory `verification/2026-10-17-wave1` (not passenger data).

Focused evidence: the broader mobile recovery slice passed 47/47; after the last
two guards, the affected reconciliation/session/logout slice passed 35/35
(18 new F01 cases). Cold workers passed 11/11; cleanup fencing 20/20 plus 135/135 focused
unit tests; first driver claim/combined flow 6/6. The final complete pass finished
successfully on 17 October 2026. Commands below exited zero; logs retain the
actual executable, arguments, duration and output. The Functions checks use
Node 22.23.3; other checks use Node 24.19.0.

| Command | Actual result |
| --- | --- |
| `npm ci`; `npm --prefix functions ci` (Node 22); `npm --prefix web-admin ci` | All three clean installs passed. Manifests and lockfiles did not change. |
| `npm run verify:refactor` | Contracts, dependency boundaries, lint, typecheck and architecture tests passed. |
| `npm run release:compatibility:check -- --base=daec49e56b9042e6ca24a1d879e44f7226f6e20f --head=WORKTREE` | No changed native inputs. |
| `npm run release:config:check` | Development, preview, TestFlight and production parity passed. |
| `npm run test:all` | 1,717 tests passed across mobile (766), Functions (670), admin (184), architecture (39), release (42) and security (16). |
| `npm run test:functions:scripts` (Node 22) | 670 passed, no skips. |
| `npm run test:login:emulators` (Node 22) | 69 passed, no skips, including all 37 new real-SDK regressions. |
| `npm run test:emulators` | 223 RTDB/Storage rules tests passed, no skips. |
| `npm run security:audit:release` | Passed unchanged release policy; zero unresolved production findings. Three residual moderate dev-tool findings are recorded separately below. |
| `npm run build:web-admin`; `npm --prefix web-admin run lint` | Both passed. |
| `npm run efficiency:check` | Passed. |
| `node scripts/measureFunctionsImport.js` (Node 22) | Clean-process require passed (609ms); Sharp and Expo server SDK remained unloaded. This is a local regression signal, not a cloud cold-start benchmark. |
| `node node_modules/expo/bin/cli export --platform ios --max-workers 2 --output-dir ../verification/2026-10-17-wave1/exports/ios` | Passed. |
| Same export command with `android` and its output directory | Passed. |
| Same export command with `web` and its output directory | Passed. |

Earlier failing runs are retained as evidence, not counted as passes. Initial
notification complexity lint failures were repaired with named private helpers.
The first broad Functions run exposed 19 failures in assignment, tracking Stop
and role-claim integration; these drove the shared-lock compatibility repairs
described below. An intermediate run interrupted for the mobile timeout/null
callback fix is not a completed gate. All final commands above ran sequentially
after the last source change; clean installs were retained because no dependency
manifest or lockfile changed.

The final mobile review also covered failure recovery: Logout Retry repeats the
captured old-tour retirement through the real purge path, remote revocation keeps
the exact session ID needed for completion, and successor authority rejects old
cleanup. Logout drains assignment storage work until its bounded tail stabilises
before removing local seeds. Cold restore retires the stored old-tour queue/cache
before showing the verified new assignment; failures preserve the seed behind the
startup Retry gate, with the session listener suspended until restore succeeds.
The drain has a 15-second total deadline and guards late continuations; a hung
offline tour read leaves cleanup retryable, retaining its pending work and
ownership fences. Obsolete revocation callbacks reject a cleared/replaced
session before dereferencing it, including the render/passive-cleanup interval.

The broad gate exposed and repaired shared-lock integration regressions: Stop
recovery and role-claim cleanup must admit missing/partial canonical records
without granting operational authority, and assignment owns its existing atomic
revision increment rather than a preliminary bump that invalidates a fresh
notification binding. Cleanup/end/revoke admission compares the captured session
ID (and scheduled candidate revision) before advancing its fence; obsolete work
leaves successor revisions unchanged. Real-SDK coverage includes obsolete policy
cleanup followed by an actual assignment page with the registered device intact.
Controlled clocks are propagated explicitly; faithful fixtures preserve original
assignment increment and passenger-isolation assertions.

Rendered admin smoke: the existing signed-in IAB Track Coaches page at
`https://loch-lomond-travel-admin.web.app/track-coaches?tour=5503L_6` rendered
meaningful content without a framework overlay; Map→List→Map changed the view
and URL correctly and restored the original view. Console warnings/errors were
empty. The screenshot `admin-smoke.png` is in the evidence directory. The
standalone Browser plugin was absent; the available built-in CUA browser used
its documented Playwright locators instead. Native radio `check()` timed out on
Mantine's styled control; clicking its visible List label worked. This smoke
covers the existing deployed UI only, at its desktop viewport; no admin frontend
source changes or new backend deployment are claimed by it. New rules and
server authority are validated in the separate local emulator gates.

## Release inventory and order

1. Release the compatible Functions consumers together. These include both
   `verifyPassengerLogin` and `verifyDriverLogin`; `endAppSession`,
   `revokeAppSession`, `assignDriverToTour`, `reconcilePassengerRoleClaims`,
   `updateDriverLocationPickup`, `stopDriverTrackingSession`,
   `updateNotificationDeviceRegistration`, `cleanupExpiredAppSessions`,
   `setDriverLoginPolicy` and `cleanupDriverLoginPolicySessions`; account deletion
   request/retry/worker entrypoints; notification fanout/recovery/receipt workers,
   admin preview/requeue/test entrypoints and all notification-producing
   triggers that share the changed queue/job infrastructure. A partial rollout
   of lock consumers and issuance ownership tags is insufficient.
2. Deploy `database.rules.json` after compatible Functions. It adds the private
   profile-tag protection and expiry audit-event index. No Storage rule or
   canonical/generated client-contract change is required.
3. Deliver the compatible F01 JavaScript to the intended TestFlight cohort.
   Verify the exact EAS update group/runtime/commit and installed update. Main's
   automatic OTA planner may require manual dispatch for unclassified changed
   configuration files; inspect its actual result. Do not infer delivery from
   a code merge. No production App Store release is implied.
4. Validate driver assignment without logout, two-phone passenger isolation,
   tracking retirement on reassignment and explicit fresh Start on the actual
   intended phone/build. Existing build-15 physical tracking evidence predates
   this change and does not establish acceptance of a new JavaScript update.

Rule digests and the shared transaction-helper dependency closure were refreshed
in the notification-retention protocol manifest. Any later deployment of that
compactor needs a matching new deployment attestation. Keep its scheduler paused;
do not reuse the old attestation or enable retention as a verification step.

Repository delivery uses `fix/wave1-reliability` through a normal protected-main
pull request. The PR and merge commit provide the immutable revision identity;
required GitHub checks must pass on the exact submitted head before merge. No
Firebase service/rules deployment or mobile publication was performed during
local verification. Deployment and the new mobile device acceptance remain
release work, in the order above.

## Separately recorded follow-ups

1. **Already-queued issuance write:** the independent review reproduced a real
   SDK-queued multi-root issuance update overwriting a successor after the old
   lease expires in both the original base and Wave 1. The 60-second HTTP timeout,
   180-second lease and fresh pre-dispatch check do not cancel an already-queued
   write. Track a separate conditional issuance/publication protocol with actual
   queued-write and crash-boundary regressions. Canonical cleanup CAS protection
   is narrower and must not be presented as general delayed-writer safety.
2. **Notification attempt aggregation:** the independent review reproduced this
   in both base and merge within the ordinary runtime/lease window. A parallel
   preparation error releases the job while a sibling's initial publication is
   pending. A successor at logical T+31 seconds publishes that prepared attempt;
   the old sibling resumes and counts it again. Two recipients receive two
   provider sends, both attempts become `provider_accepted`, and retry/receipt
   queues empty, but job and broadcast remain `retrying` with a phantom retrying
   count of one. Ordinary terminal retention is therefore ineligible. This case
   did not demonstrate duplicate pushes. Track an idempotent attempt/count/queue
   publication repair with failure and crash-boundary tests. Cold-cache progress
   acceptance alone does not close this accounting defect.
3. **Development-tool audit:** the full root graph retains three residual
   moderate findings (`@google-cloud/pubsub`, `@opentelemetry/core` and
   `firebase-tools`) under the existing source-verified mitigation policy.
   Production has no unresolved findings; raw advisory totals are not zero.
   Functions and web-admin audits report zero vulnerabilities. No audit policy,
   dependency override or security threshold was weakened for this work.
4. **Navigation storage after cleanup:** an already-issued navigation storage
   batch can restore booking/tour seeds after remote cleanup succeeds while the
   app-session key remains absent. This is incomplete local data removal, not
   restored app authority. Assignment-task draining does not cover every storage
   writer. Track a coherent all-writer persistence/cleanup protocol and test a
   paused navigation batch across final deletion before claiming complete removal.

These are separate bounds found during review, not hidden test skips. There are
no production maintenance mutations or live flag changes in the verification.
