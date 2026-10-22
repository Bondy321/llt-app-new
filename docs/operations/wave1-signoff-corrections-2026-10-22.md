# Wave 1 sign-off corrections — 22 October 2026

Reviewed/source starting point: `dc0bac5b501278ec75d0a9e6adcd511337cac49d`
(PR #485), with original audit base `daec49e56b9042e6ca24a1d879e44f7226f6e20f`.
The checkout and fetched main matched the reviewed merge and were clean. Work is
on `fix/wave1-signoff-corrections`; no user changes were reset. Final commit/CI
identity is recorded in the delivery PR and the external evidence manifest.

This is repository correction and source verification only. Firebase deployment,
rules deployment, EAS publication, live flag changes and maintenance operations
are outside this task. Previous build-15 acceptance is not evidence for this code.

## Mandatory corrections

### W1R-01 — login projection ownership

The original login exposed the verified session before creating its driver
identity projection. Initial duplicate listener work could capture an empty
booking and later replace the correct identity. Original login continuations
could also restore an earlier tour after a higher assignment revision.

The correction coordinates verified identity creation with activation and fences
subsequent projection/save work by the current installation, session and revision.
The intended notification-onboarding route remains part of that coordination.
An old callback captured while `appSession` was null cannot bypass current
authority checks. Pending assignment may withhold tour access while retaining the
verified driver identity and a functioning revocation listener.

Onboarding completion is explicit intent, independent of delayed assignment
storage, so later assignment and login continuations cannot reopen it. The
logout-state fence is synchronous with state updates, including a fresh login
after completed logout.

Affected components: login/session phases, driver login and assignment runners,
guarded persistence, AppShell state coordination and mounted logout lifecycle.
`tests/driverSessionMountedLifecycle.test.js` exercises real mounted React state
and the real login, session service, assignment, save and cleanup paths; only
external adapters are controlled. Its null-initial-state baseline reproduced
`bookingData.id === undefined` after the delayed assignment read.

### W1R-02 — subscription ownership after repair

Operational retirement advanced `sessionGenerationRef`, also used as logout
subscription ownership. A duplicate repair retained the accepted session object,
so the mounted effect did not renew that captured generation. A real null event
was then ignored. The baseline mounted test observed zero local cleanup calls.

Subscription ownership is separated from operational-work generation. Current
deletion, expiry and genuine identity replacement remain actionable after a
duplicate repair; cleared/replaced authority and obsolete effect callbacks remain
fenced. Accepted expiry takes effect before asynchronous projection work, while
same-tour revision-only changes retain tracking, replay and navigation.
Expiry callbacks identify the authority that expired: an old timer cannot revoke
a just-renewed HTTP session before React replaces its subscription. A genuinely
newer expired session remains actionable.

### W1R-03 — stale deletion admission

`reserveAccountDeletion` admitted `revoke` without the captured expected session
ID. The scope check rejected A only after B's revision had advanced. The
correction validates the ID before locking and passes it into conditional
admission, retaining downstream scope validation because acquisition alone is
not proof of an exact match.

The five genuine-SDK regressions in
`tests/accountDeletionAdmission.emulator.test.js` use actual issuance,
registration, deletion reservation and assignment. The pre-fix run had three
failures (stale driver, stale passenger, invalid ID) and two passing valid deletion
controls. It observed driver B revision 1→2 before rejection, followed by actual
assignment disabling delivery; corrected assertions compare the complete session
and device/consent state and require no job/barrier/tombstone on rejection.
Passenger membership and sibling authority are included.

All revision-advancing callers were reviewed. Captured logout/revocation/expiry/
policy/deletion operations pass their expected ID; issuance deliberately replaces
current authority. Admin current-session revocation retains its supported optional
ID. Deletion completion has already shredded private session scope and instead
relies on the permanent UID tombstone, durable active barrier and exact job lease.
The caller matrix is in [account-deletion operations](./account-deletion.md).

### W1R-04 — first notification registration ownership

First registration previously derived ownership from existing device state or
operational eligibility. A valid unassigned or ineligible successor could remain
untagged. Old cleanup's post-takeover snapshot equality then matched that device
and revoked its token/marketing state before final canonical cleanup failed.

Registration derives ownership from server-verified current session authority
independently of operational delivery. Device, consent and audience writes retain
ownership/lease fences across awaited work; a stale supplied session cannot claim
a successor. Cleanup no longer treats an untagged equal snapshot as proof of old
ownership. Marketing-only and supported logged-out registration remain separate
from operational eligibility, with permanent deletion tombstones preserved.

Mobile logout ends canonical authority before retiring notification delivery.
Exact server-owned ended-session logout and its interrupted projection retry
remain supported, using stored consent rather than accepting expired payload
upgrades. A different successor session always rejects that recovery.

`tests/notificationOwnership.emulator.test.js` uses actual Admin transactions and
production issuance, registration and cleanup. The baseline absent-device tests
failed for both unassigned and assigned-but-ineligible successors; the existing
device control passed (two failures, one pass). The absent-device cases do not
seed a notification device. Rules tests explicitly cover client/admin attempts to
write/remove the private ownership tag.

## Verification and evidence

Primary changed-file ownership (paths relative to the repository):

| Finding | Implementation | Regression files |
| --- | --- | --- |
| W1R-01 | `src/app/session/{driverLoginOwnership,loginRunners,loginSessionPhases,sessionSaveRunner,useLogoutStatus}.js`, `src/app/driver/{driverLoginRunner,driverAssignmentRunners}.js`, `src/app/notifications/notificationOnboardingRunners.js`, `src/app/AppShell.js`, `services/appSessionService.js` | `tests/driverSessionMountedLifecycle.test.js`, `tests/helpers/mountedDriverSessionHarness.js` |
| W1R-02 | `src/app/session/useLogoutLifecycle.js`, `services/appSessionService.js`; shared assignment/login ownership above | Same mounted suite, plus existing `tests/driverSessionReconciliation.test.js`, `tests/appSessionService.test.js` and logout suites |
| W1R-03 | `functions/src/domains/account-deletion/accountDeletionFunctions.js` | `tests/accountDeletionAdmission.emulator.test.js` |
| W1R-04 | `functions/src/domains/notifications/{notificationDeviceFunctions,notificationMarketingAudience}.js`, `functions/lib/appSessionCleanupAuthority.js` | `tests/notificationOwnership.emulator.test.js`, `tests/firebaseRules/notifications.rules.test.js` |

Prerequisites: `package.json` wires the mounted and SDK tests into normal CI;
`functions/src/domains/notification-retention/protocol.js` and its test bind the
shared cleanup dependency; `scripts/release/updatePlan.js` and
`tests/release/updatePlan.test.js` block automatic coupled mobile/backend delivery.
The relevant architecture, session, notification and deletion contracts are
updated alongside these implementations.

The fresh release audit also rejected the admin's development-tool graph:
Vite 7.3.6 had one high advisory (plus lower findings), and Vitest/mocker 4.1.11
had two moderate mocker advisories. `web-admin/package.json` and its lock now pin
Vite **7.3.7** and Vitest **4.1.12**. Only Vite and the matching Vitest package
family changed versions; there is no major upgrade, production dependency change
or audit-policy exception. Maintainer references: [Vite/launch-editor advisory](https://github.com/vitejs/launch-editor/security/advisories/GHSA-587h-7wmj-h5pm),
[Vitest manual mock registration](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8)
and [Vitest Windows traversal](https://github.com/vitest-dev/vitest/security/advisories/GHSA-xp26-3454-mjgp).

Evidence directory: `C:\Users\sa08b\Documents\App_Full\verification\2026-10-22-wave1-signoff`.
It contains no production passenger fixtures. Baseline logs are
`w1r01-02-before.log`, `w1r03-before.log`, and `w1r04-before.log`; earlier harness
setup errors are not credited as defect reproductions. All four failures were
demonstrated before their production fixes.

Runtime inventory: Node 24.19.0/npm 11.17.0 for mobile/admin/tools;
Node 22.23.3 for Functions compatibility and genuine SDK tests; Temurin Java
21.0.11 for emulators. Commands use `TZ=Europe/London`. Local gates run
sequentially; test file concurrency is at most two and SDK suites one. Synthetic
writes require explicit loopback hosts and `demo-*` projects. Tests remove their
fixtures/connections and emulator processes stop after each execution.

All 18 final local stages completed successfully. The 29 frozen source/test/JSON
files matched their recorded SHA-256 hashes after the last gate. Counts below are
per command (overlapping suites must not be added into a unique-test total).
Every counted final suite had **zero failures, cancellations and skips**.

| Final command | Result | Evidence log |
| --- | --- | --- |
| `npm ci`; `npm --prefix functions ci`; `npm --prefix web-admin ci` | Passed, with unchanged root/Functions install reuse explained below | `gate-install-*.log`, `gate-results.json` |
| `npm run verify:refactor` | Passed lint, strict typecheck, contracts and 65 tests | `gate-verify-refactor.log` |
| `npm run test:all` | 1,746 passed | `gate-test-all.log` |
| `npm run test:functions:scripts` under Node 22 | 671 passed | `gate-functions-node22.log` |
| `npm run test:login:emulators` under Node 22/Java 21 | 89 passed | `gate-login-emulators-node22.log` |
| `npm run test:emulators` | 223 passed | `gate-rules-emulators.log` |
| `npm run security:audit:release` | Passed the unchanged qualified policy; details below | `gate-security-release.log` |
| `npm run release:compatibility:check -- --base=dc0bac5b501278ec75d0a9e6adcd511337cac49d --head=WORKTREE` | Passed, no changed native inputs; repeated with committed SHA before push | `gate-release-native.log`, `committed-release-native.log` |
| `npm run release:config:check` | Passed | `gate-release-config.log` |
| `npm run build:web-admin`; `npm --prefix web-admin run lint` | Both passed | `gate-web-build.log`, `gate-web-lint.log` |
| `npm run efficiency:check` | 92 passed | `gate-efficiency.log` |
| `node scripts/measureFunctionsImport.js` under Node 22 | Passed, 3,046 ms local import; not a deployed cold-start benchmark | `gate-functions-load-node22.log` |
| `node node_modules/expo/bin/cli export --platform <ios/android/web> --max-workers 2 --output-dir <evidence>/exports/<platform>` (three sequential commands) | All three exports passed | `gate-expo-ios.log`, `gate-expo-android.log`, `gate-expo-web.log` |

`gate-results.json` records the exact executable, arguments, duration and exit
code for every stage; `gate-summary.json` records the per-command counts.

Fresh release audit: root production has 27 raw findings, all 27 verified
mitigated, zero unresolved. Root full graph has 31 raw findings, 28 verified
mitigated and three unresolved moderate records: `@google-cloud/pubsub`,
`@opentelemetry/core`, and `firebase-tools` (the last has raw inherited high
severity, assessed residual moderate under the existing policy). Functions and
admin production/full graphs each have zero raw findings. This is a qualified
release-policy pass, not a claim that the repository has zero raw vulnerabilities.

The built admin also passed a local Chrome smoke check at `http://127.0.0.1:4187/`
using Playwright CLI 0.1.21 (Browser plugin not available). At 1280x800 and
390x844, the correct login screen rendered without a blank page, framework
overlay or visible clipping. Reset dialog open/cancel worked at both sizes;
the final dialog count was zero and mobile document width equalled viewport
width. Console inspection returned zero errors/warnings. Screenshots are
`admin-desktop.png`, `admin-mobile.png` and `admin-mobile-dialog.png`, with DOM
snapshots under `.playwright-cli/`. This unauthenticated local smoke did not send
email or verify authenticated production operations. The owned browser and
preview process were closed afterwards.

The first full pass stopped correctly at that newly reported admin development
audit failure, after application, Node 22 and emulator tests had passed. Its logs
are retained under `pre-audit-fix/`; they are not credited as the final broader
pass. After the patch-level lock update, the admin dependencies were clean-installed
again and every final verification stage rerun. The unchanged root and Functions
dependencies reuse their successful clean installs from the same session (recorded
in `pre-audit-fix/gate-results.json`); their manifests/locks and dependency-patch
policy did not change. The final release audit re-verifies installed mitigation
bytes. This avoids repeating two unchanged installations, not any verification gate.

One post-patch application pass stopped with a Vitest thread-startup timeout before
`ToursManager.test.jsx` ran; seven component files/21 tests had passed, but that
incomplete command is not accepted evidence. The same ToursManager file then
passed all 13 tests with unchanged worker and timeout settings. The complete
`test:all` command was rerun, followed by the remaining gates. The interrupted
logs/results are under `worker-start-timeout/`, with the independent check in
`tours-worker-recheck.log`. No assertions, timeouts, worker limits or test selection
were weakened to obtain the final result.

Focused final-source results (all zero failures and zero skips):

| Correction | Representative retained regression | Result / evidence |
| --- | --- | --- |
| W1R-01 | `fresh driver login initial session event cannot replace verified identity after onboarding`; higher-assignment/onboarding/identity/pack, unassigned-first-assignment and logout variants | Shared mounted suite: 27 passed, `w1r01-02-after.log`; 65 existing affected tests, `w1r01-02-existing.log` |
| W1R-02 | `mounted duplicate assignment repair still acts on genuine remote deletion`; expiry/replacement, HTTP-renewal-before-passive-cleanup and genuine newer expiry variants | Included in the same 27 mounted cases, not an additional count |
| W1R-03 | `stale driver deletion preserves the complete successor and registration through actual assignment`; passenger/sibling, invalid ID and valid exact-session controls | 5 SDK tests passed, `w1r03-after.log`; 14 existing unit tests, `w1r03-unit.log` |
| W1R-04 | `full stale cleanup preserves ...` absent/existing/ineligible device cases; paused registration, ended logout/retry, tombstone and legacy controls | 15 SDK tests plus 14 rules tests passed, `w1r04-final-sdk-rules.log`; 46 existing unit tests, `w1r04-units.log` |
| Release prerequisites | Coupled backend/manual OTA and marketing-cleanup source attestation | 18 planner tests and 14 protocol tests passed, `ota-guard-after.log`, `retention-manifest-after.log` |

Independent source review found and checked the additional onboarding, renewed
expiry and ended-logout compatibility corrections. `source-freeze.json` records
SHA-256 hashes of the final implementation and regression files; the final gate
and exact-commit CI are the authoritative broader verification below.

Preserved worker acceptance is narrow: real SDK cold queue/job claims, leases,
continuations, retry/receipts, stale owners and duplicate invocations; deletion
reaches durable completion with actual emulator Auth deletion and retained
sibling/roster/tombstone assertions. The deletion fixture has empty media
collections and a synthetic bucket adapter: it is not a live Storage-object
deletion test. Separate media-generation/ownership tests remain in the normal gate.

## Release dependency and overlap condition

The following condition is **not established by source tests or merge**. The Wave
1 fanout failure path can CAS a new canonical queue pointer before publishing its
leaf. It retains the old leaf for new-worker recovery. A pre-Wave-1 worker can
instead discard that stale pointer, losing the only recovery path. A generic
"deploy all Functions together" instruction does not make rolling overlap safe.

There is currently no verified production quiescence switch for all of these
consumers in this repository. This correction does not claim mixed-version queue
recovery. **Deployment remains blocked on resolving that overlap condition** by
either a separately tested compatible handoff or a verified maintenance window.
No production deployment is authorised or attempted here.

A maintenance release must meet these concrete conditions before it is executed:

1. Inventory the deployed revisions, Eventarc targets, scheduler jobs, HTTP
   ingress and timeout/retry settings for every consumer listed below. Record the
   baseline artifacts and exact rollback revisions. Source metadata is not proof
   of deployed configuration.
2. Stop new source/admin writes and pause scheduled fanout, receipt/retry, session
   cleanup, policy cleanup and account-deletion work. Block admission to the
   affected HTTP/RTDB consumers using an independently verified platform
   mechanism. A paused scheduler alone does not stop RTDB triggers, queued event
   delivery, HTTP requests or already-running invocations. Do not delete source
   events or runnable queue records to create apparent quiescence.
3. Prove all old invocations and outstanding database writes have drained, using
   revision-specific platform evidence and stable bounded queue/job observations.
   Waiting for the source timeout or lease duration alone is insufficient,
   including for already-queued SDK issuance writes. If this cannot be proven,
   the maintenance route is unsupported and compatible recovery must be built.
4. With admission still closed, release the complete consumer set. Confirm every
   target uses the intended code/runtime and old revisions have no active work.
   Reconcile every canonical queued-job pointer against its expected leaf in
   bounded key pages, using conditional publication and preserving current
   leases, retention fences and exact versions. Do not claim an empty due page
   proves full reconciliation. No such production repair is run by this task.
5. Deploy dependent RTDB rules after compatible Functions; preserve explicit App
   Check settings and limited Command Centre access. Keep retention scheduling
   paused. Confirm due/retry/receipt recovery and resumable deletion before
   reopening writers and consumers. Record outcomes, not just deploy success.
6. Publish the intended TestFlight JavaScript update only after backend/rules
   verification. Confirm update group, runtime, Git commit and actual installed
   update. The planner now requires manual delivery for coupled mobile/backend
   changes; an automatic merge must not publish this correction.

Rollback follows the same admission-close/drain proof. Before restoring old
queue consumers, ensure no new-pointer/missing-leaf handoff remains and every
canonical runnable pointer has a recoverable matching leaf. If that cannot be
established, keep consumers closed and recover forward; do not restore an old
worker that can discard the only recovery pointer. Never remove deletion barriers,
tombstones or successor ownership tags to make a rollback appear compatible.
Rollback must not publish old mobile code without confirming backend compatibility.

The inventory is conservative at the deployed module boundary: a handler can
share changed dependency code with another export in the same module. The
external `function-inventory.json` records changed transitive paths against the
original audit base, so the unreleased Wave 1 changes are included.

| Group | Affected exported Functions |
| --- | --- |
| Login/session/assignment | `verifyPassengerLogin`, `verifyDriverLogin`, `endAppSession`, `revokeAppSession`, `assignDriverToTour`, `reconcilePassengerRoleClaims`, `updateDriverLocationPickup`, `stopDriverTrackingSession`, `getDriverLoginPolicy`, `setDriverLoginPolicy`, `cleanupDriverLoginPolicySessions` |
| Shared maintenance module | `cleanupExpiredAppSessions`, `cleanupExpiredDriverLocations`, `cleanupExpiredDriverTourPacks`, `cleanupExpiredLoginRateLimits` |
| Account deletion | `requestAccountDeletion`, `getAccountDeletionStatus`, `retryAccountDeletion`, `processAccountDeletionJobs` |
| Notification registration/details/projection | `updateNotificationDeviceRegistration`, `getMarketingNotificationDetail`, `getSafetyAlertDetail`, `projectNotificationMarketingAudience`, `projectNotificationMarketingAudienceConsent` |
| Notification delivery/admin | `processNotificationDeliveryJob`, `recoverNotificationDeliveryJobs`, `processNotificationReceipts`, `cleanupNotificationDeliveryData`, `previewNotificationAudience`, `createServerTestNotification`, `requeueNotificationJob` |
| Notification producers | `processBroadcastWrite`, `processCategoryBroadcastWrite`, `sendChatNotification`, `sendInternalChatNotification`, `sendDriverTourPackChangeNotification`, `sendItineraryNotification`, `sendSafetyAlertNotification` |
| Passenger-trip shared module | `getPassengerTripSnapshot`, `projectPassengerTripBooking`, `projectPassengerTripItinerary`, `projectPassengerTripTourName`, `projectPassengerTripTourTourCode`, `projectPassengerTripTourDestination`, `projectPassengerTripTourStartDate`, `projectPassengerTripTourEndDate`, `projectPassengerTripTourDuration`, `projectPassengerTripTourActive`, `projectPassengerTripTourCurrentParticipants`, `projectPassengerTripTourMaxParticipants`, `projectPassengerTripTourDriverName`, `projectPassengerTripTourDriverPhone`, `projectPassengerTripTourAssignmentRevision` |

This batch does not require new native dependencies, a canonical client-session
shape change or a new binary solely for these JavaScript corrections. The prior
Wave 1 RTDB profile-tag protection and audit-event index still require deployment
after Functions. Any changed retention dependency closure produces a new protocol
fingerprint and needs fresh deployed attestation before later activation; keep the
retention scheduler paused throughout this work.

The inventory contains 53 exports. The retention source manifest now explicitly
includes the shared marketing-audience module; its byte-change regression proves
old source attestation cannot be reused. RTDB rule artifact digests are unchanged
in this correction batch.

## Physical acceptance, pending corrected release

- Fresh assigned and unassigned driver login preserves driver mode/manifest and
  the intended notification onboarding; first assignment works without logout.
- Assignment changes during login and during a retry retain the latest tour;
  removal returns to unassigned mode. Revoke/expire/logout while loading cannot
  restore a tour afterwards.
- Reassignment retires old tracking/replay/cache state and needs fresh explicit
  Start. Repeat locked-screen movement, network recovery, Stop, force-close and
  logout on the intended phones, with independent server/passenger-map observation.
- Two passenger phones retain independent sessions; logout/deletion on one
  preserves the other's supported authority and the established shared-content
  deletion scope.
- First marketing-only registration keeps consent/token with current ownership;
  stale cleanup/deletion cannot alter the successor's notifications. Provider
  acceptance and device display must be reported separately.

## Independent follow-ups retained

These are not substitutes for any mandatory correction. The demonstrations below
come from the independent sign-off review; this correction does not claim they are
repaired. See the corrected [Wave 1 handover](./wave1-reliability-2026-10-17.md).

| Follow-up | Demonstrated impact | Next required repair/evidence |
| --- | --- | --- |
| Notification initial publication/count/queue | Parallel preparation failure plus a pending sibling causes a phantom retrying count within the ordinary lease/runtime window; two provider sends for two recipients, no duplicate push demonstrated; job/source remain retrying and ordinary terminal retention is ineligible. | Idempotent publication/accounting protocol with parallel-failure and crash-boundary tests. |
| Already-queued issuance | Actual queued multi-root write can overwrite a successor after lease expiry in both base and merge. HTTP timeout metadata does not cancel it. | Conditional issuance/publication coordination tested with real queued SDK writes. |
| Navigation storage after cleanup | Already-issued navigation batch can restore booking/tour seeds after cleanup while app-session key remains absent. Incomplete local data removal, not restored authority. | Cover every storage writer in the final cleanup protocol and test paused navigation across deletion. |
| Dependency audit | Historical raw advisory totals are non-zero; existing source-verified mitigations are qualified, not advisory removal. | Retain the unchanged release policy and record fresh raw/mitigated/residual results below. |

## Final verdicts

| Finding | Source / automated verdict | Evidence |
| --- | --- | --- |
| W1R-01 | PASS | Genuine null-state mounted login, identity/persistence/scope, later assignment and onboarding fencing; baseline failure and 27-case final mounted suite |
| W1R-02 | PASS | Mounted repair followed by actual cleanup on null/expiry/replacement, obsolete callback and renewed-expiry controls; same mounted suite |
| W1R-03 | PASS | Five real-SDK deletion-admission cases assert full successor authority and device preservation through actual assignment, plus exact-session and passenger controls |
| W1R-04 | PASS | Fifteen real-SDK ownership cases cover absent device, ineligible successor, stale cleanup/registration and supported ended/logout marketing; private-tag rules controls |

**Source readiness: ready for independent reassessment. Automated verification:
all required local gates passed.** Normal protected-main delivery must also retain
all six successful checks for its exact head; the delivery PR and external
`repository-delivery.json` identify the tested commit, merge and check results.
The source record is carried by that commit; no self-referential commit hash is
embedded in its own contents.

F04 cold-cache/worker acceptance remains qualified as described above; F06
first-driver claim and the affected F01 assignment/F05 cleanup controls remain
covered by the successful final suites. The separate notification accounting
protocol is not claimed repaired.

**Deployment readiness: blocked on the unresolved old/new worker overlap condition.**
No production deployment, EAS publication, flag change or maintenance was performed.
Physical-device acceptance of this corrected source remains pending its authorised
release and the checklist above; prior build-15 results do not satisfy it.
