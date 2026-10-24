# First public launch verification — 24 October 2026

This record accompanies the [launch contract, findings and preparation checklist](first-public-launch-2026-10-24.md).
The [access matrix](first-launch-access-matrix.md), [mobile reliability record](first-public-launch-mobile-reliability.md),
[notification capacity measurements](../performance/notification-launch-capacity.md) and
[monitoring configuration](first-launch-monitoring.md) provide the detailed boundaries.

## Delivery and runtime provenance

Repository delivery uses each repository's actual PR/CI requirements. The completion
response and associated app PR record the exact delivered app revision and CI run;
this report records the implementation and reproducible verification boundaries.
No production deployment, shared reset, import replay, customer message, native build,
OTA, TestFlight submission or store publication is authorized by this task.

The app started from current main `05ba9d1d285f45e4d33b7bd9ad20749bd3e4c945`, after
[PR489](https://github.com/Bondy321/llt-app-new/pull/489) removed automatic push-triggered OTA publication.
That safety change was delivered before functional launch changes. The underlying
reviewed app head `d50f4bbfd8c7f926ce3c15100b173c165f9a761d` and importer main
`48fabcd64e1fdb2dbf6f2b56a2c9520afea7783e` were preserved.

Importer candidate `328e15356c7e062e9565ede11802dface592214b` was delivered through
[PR7](https://github.com/Bondy321/llt-app-sync/pull/7), merged normally as
`728d478880daeb420d8641bd46f3f5f5f9466a05` on 24 October. Its exact-head
[container CI](https://github.com/Bondy321/llt-app-sync/actions/runs/40083765897)
passed fresh `--pull --no-cache` container build, certificate/HTTPS checks,
`pip check`, application entrypoint and **221 tests with zero skips**.
Local Python 3.14.9 independently passed the trust check and all 221 tests.
These are overlapping runs, not 442 unique tests. The app's real-SDK publication
tests separately load the full production rules and exercise the shared boundary;
the importer fixture rules alone are not evidence for the full app rules.
The merged importer revision independently passed
[main CI](https://github.com/Bondy321/llt-app-sync/actions/runs/40089669984).

| Runtime surface | Evidence and limit |
| --- | --- |
| Local tooling/mobile/admin | Actual Node 24.22.1; trust guard before installation and gates; bundled Undici 7.30.1 |
| Local Functions | Actual Node 22.23.4; independent trust guard; bundled Undici 6.29.1 |
| SDK emulators | Java 21; loopback demo projects; one SDK suite at a time |
| Importer | Python 3.14.9, pinned container digest, hash-verified pip 26.2.2, certifi 2026.10.19; local OpenSSL 3.5.9 and container OpenSSL 3.5.7 are separate surfaces |
| GitHub CI | Bash-only exact-event checkout and checksum-pinned Node bootstrap; no JavaScript actions are invoked and no provider-owned binary is modified |
| Remote EAS | Source pins and pre-install trust/provider guards prepared; actual 1.1.0 remote build remains unperformed |
| Managed Functions serving image | No deployment performed; actual provider-managed serving-runtime patch proof remains required |

## Findings and retained acceptance

All listed local regressions passed the integrated gates below. Native provider,
device behavior and cloud performance are explicitly separate acceptance.

| Finding / current reproduction | Correction and retained regression | Remaining acceptance dependency |
| --- | --- | --- |
| Public driver ID was sufficient staff proof | Private, expiring, single-use enrolment; exact installation and generation. Wrong/expired/consumed secrets, competing redemption, shared-phone role switch and revoke tests | Configure admin TOTP and enrol intended devices |
| Old dispatched issuance could overwrite a successor | Prepared/committed installation epoch plus restricted atomic publication; offline SDK A/B, deletion, retry and complete derived-state checks | Matching deployed Functions and rules |
| Login coordination initially denied its own reservation | Exact server-issued assignment/policy admission proof; expiry, replacement, policy revision and committed-enrolment recovery regressions | None beyond matching deployment |
| Notification preparation siblings could leave phantom counters | Drained admitted siblings, conditional attempt versions and recoverable publication/outbox; baseline phantom retry reproduced; failure injection and real queued-write tests | Cloud contention/cost acceptance; no exactly-once display claim |
| Public device deletion could retire successor notification ownership | Removed public delete action; trusted account-deletion worker retained; current and obsolete HTTP delete attempts leave successor state intact | None beyond matching deployment |
| Queued registration/media work could outlive authority changes | Commit-time session, policy, assignment, staff and deletion checks; false/malformed markers and policy-transition SDK regressions; actual media-rule/generator parity test | Matching rules and provider setup |
| Parent grants bypassed checked media/safety handlers | Direct metadata deletion and safety-copy mutation denied, including MFA-admin ancestor paths; real HTTP positive and negative tests remain | Admin acceptance on deployed exact candidate |
| Late storage completion could recreate cleared state | Durable blocked generation plus tracked writer drain; mounted storage pauses across logout, deletion and principal/assignment changes | Exact-binary process-death and offline checks |
| Account-deletion recovery could replace a successor Auth object | Exact captured object checked across token, restore, sign-out, persistence and anonymous recovery; same-UID replacement and deadline regressions | Exact-binary deletion/recovery check |
| F02 indefinite offline startup | Bounded five-second decision and exact permitted cache scope; fresh SDK pending read and mounted restore tests | Physical cold offline start |
| F03 boarding conflict/cache divergence | Durable canonical settlement shared by automatic/manual retry, newer local intent overlay; two-handset SDK and mounted restart tests | Physical offline/reconnect journey |
| F07 draft loss or false sent state | Immutable durable scoped chat item before draft clearing; storage failure, unknown acknowledgement and restart tests | Physical process interruption |
| F08 importer/admin lifecycle race | Shared component leases and commit-time restricted writes; deletion tombstones and generation-matched cleanup; both repositories' real-SDK interleavings | Coordinated deployed artifacts; disposable Storage preconditions check |
| F09 Tour Pack supersession | Separate immutable mutation and supersession identities; restart, late-result and server admission tests | Feature remains globally disabled except exact approved drivers |
| F10 gallery truncation | Stable bounded cursor and exhaustion semantics; genuine SDK pages beyond 60, equal timestamps, deleted cursors and insertion tests | Device gallery journey |
| F11/F12 image latency and old push targets | Immediate text, bounded independent signing and exact older-target resolution; failure/hanging signer/deletion/switch tests | Device notification/media journey |
| F13 blank restored destination | Verified route inputs and Home fallback; production navigation/storage hooks after recreation | Physical process restart |
| F14 notice ownership | Canonical current principal for push, in-app and bulk acknowledgement; same-UID role-switch and rules tests | Device unread consistency |
| F15 stale exact admin tour | Exact-record subscription precedence and deletion invalidation; mounted edits/deletion without URL changes | Deployed admin smoke check |
| App Check and privileged administration | Native provider bridge, required HTTP headers, production fail-closed guards, TOTP/allowlist and revoked/disabled identity checks | Actual provider registrations/tokens, MFA recovery and new binaries |
| Android compiler defaults did not meet RNFirebase 27 requirements | Explicit Kotlin 2.4.0/API 24 and matching KSP configuration; actual Expo mods generate and reapply the native files, rejecting conflicting templates | Real Android compilation and provider/device acceptance; generated files alone do not prove compilation |
| Real account deletion | Nonempty Storage source/variant removal, bounded chat paging, exact device ownership and Auth-last recovery | Real bucket generation-zero/replacement 412 checks; emulator does not implement preconditions |
| Capacity and service health | Bounded indexed discovery, shared project push budget, fair lane budgets, resumable cleanup and prepared alerts including missing health reports | Authorized representative isolated cloud run and alert-channel activation |
| Runtime/dependency security | Retained October 23 certificate/runtime remediation; targeted Zod, body-parser and same-major Undici fixes; vulnerable behavior and actual consumer regressions | Managed runtime evidence; documented moderate tooling findings |
| Publication could happen on an ordinary push | Automatic OTA removed first; manual exact-SHA checks, artifact provenance, native compatibility and provider prerequisites retained | Explicit owner publication after final acceptance |

## Supported and retired behavior

Supported launch version/runtime is **1.1.0**. New iOS and Android binaries are
required. Earlier build-15 phone results and JavaScript exports cannot establish
acceptance for the new native graph.

Retired authorization includes scalar passenger device ownership, missing staff
approval/policy generations, direct-client deletion orchestration, old location
projection writers, and obsolete notification work roots. Current consented
logged-out marketing remains supported separately from operational eligibility.
The exact ended-session notification logout can retry without touching a successor.

Retained recovery includes multi-phone passenger authority, pending logout and
tracking withdrawal, accepted deletion receipts/barriers/tombstones, durable unsent
actions, and exact current-session restore. Genuine older bookings, missing-email
roster-only passengers, transfer journals, both history archives, fresh passenger
occurrence IDs and manual additions remain business data. The dry-run tester reset
allowlist is empty because no live UID was independently proved wholly synthetic.

## Verification results

Local verification used `TZ=Europe/London`, at most two Node test files and one SDK
suite at a time. Concurrent security files hit intermittent 15-second consumer
startup failures on this Windows machine, before requests began. The suite now
loads one file at a time to reduce contention between the actual Expo, Firebase CLI
and jsdom dependency graphs; the unchanged checks subsequently passed. The precise
operating-system scheduling or I/O cause was not established. No test deadline or
assertion was relaxed. Earlier failures remain in the evidence
directory, alongside the subsequent complete runs.

| Command / boundary | Executed result | Evidence log |
| --- | --- | --- |
| `npm run verify:refactor` | 28 contract and 40 architecture tests passed; architecture/dependency checks, lint and types passed; zero skips | `candidate-refactor.log` |
| `npm run test:all` | 1,921 passed (1,709 Node + 212 admin), 0 failed, 0 skipped | `candidate-test-all.log` |
| `npm run test:functions:scripts` on Node 22.23.4 | 716 passed, 0 failed, 0 skipped | `functions-node22-verified.log` |
| `npm run test:login:emulators` | 197 passed, 0 failed, 0 skipped | `login-sdk-verified.log` |
| `npm run test:emulators` | 225 passed, 0 failed, 0 skipped | `rules-sdk-verified.log` |
| `npm run test:deletion:emulators` | 8 passed, 0 failed, 0 skipped; nonempty Storage fixtures | `deletion-sdk-verified.log` |
| `npm run test:security` | 61 passed inside the final full suite, 0 failed, 0 skipped; earlier standalone run passed 58 before three native configuration tests were added; unchanged child deadlines | `candidate-test-all.log`, `security-serial.log` |
| `npm run test:release` | 53 passed, 0 failed, 0 skipped | `release-verified.log` |
| `npm run efficiency:check` | 73 Node and 19 mounted admin cases passed, zero skips | `efficiency-verified.log` |
| `npm run security:audit:release` | Passed; raw/mitigated/residual results below | `audit-verified.log` |
| `npm run release:compatibility:check -- --base=05ba9d1d285f45e4d33b7bd9ad20749bd3e4c945 --head=WORKTREE` | Passed; genuine native changes require 1.1.0 binaries | `candidate-compatibility.log` |
| `npm run release:config:check` | Passed | `candidate-config.log` |
| Admin lint and `build -- --mode verification` | Passed; output is nondeployable `verification-dist` | `admin-lint-verified.log`, `admin-build-verified.log` |
| Lint of the four final corrected mobile fixtures | Passed | `final-fixture-lint.log` |
| Native provider/configuration regressions | 7 passed, 0 failed, 0 skipped; actual installed Expo template/mod pipeline and fail-closed guards | `native-config-final.log` |
| Sequential iOS, Android and web exports | All three passed; bundling only, not native compilation or device acceptance | `ios-export.log`, `android-export.log`, `web-export.log`, `exports-results.json` |
| Source and build-artifact credential scan | 1,159 source files and 41 artifact files; zero high-confidence credential matches. One artifact contains public client API configuration | `final-secret-scan.json` |
| Importer local/container suites | 221 passed, 0 failed, 0 skipped in each run | Candidate and main CI links above |

The standalone Functions, security, release, architecture, efficiency and focused
mobile runs overlap the full application suite. These are independent execution
results, **not** numbers to add into a unique-test total. Local evidence is retained
under `C:\Users\sa08b\Documents\App_Full\verification\2026-10-24-first-public-launch`;
the final app PR and both repositories' CI provide remotely accessible logs.

All dependency graphs with changed inputs received clean installs. Subsequent
test-fixture and script-only changes reused those identical installed graphs.
The dependency regressions exercise actual installed consumers, including Expo's
Zod/MCP schema path, both body-parser majors, Firebase CLI, node-gyp and jsdom.
The [certificate/dependency record](certificate-trust-2026-10-23.md#24-october-dependency-advisory-follow-up)
retains the reproduced vulnerable behavior and the precise limits of each check.

| Audit scope | Raw high / critical | Verified mitigated high records | Unresolved findings |
| --- | --- | --- | --- |
| Root production | 7 / 0 | 7 | 0 |
| Root including development tools | 7 / 0 | 7 | 5 moderate |
| Functions, production and full graph | 0 / 0 | 0 | 0 |
| Admin, production and full graph | 0 / 0 | 0 | 0 |

The five moderate development-tool records are `@google-cloud/pubsub`,
`@opentelemetry/core`, `fast-uri`, `firebase-tools` and `ip-address`. No new audit
exception was introduced for Zod, body-parser or Undici. This is not a zero-advisory
claim. The seven raw high records retain their existing source/hash-verified
installed mitigation, rather than being hidden from the registry result.

The final pass also corrected test fixtures that lacked authenticated users or
App Check, and old assertions that expected direct-client safety writes. Real SDK
denial tests remain mandatory; the corrected mobile fixtures additionally inspect
Auth/App Check request headers and preserve the stalled-token deadline checks.

## Launch verdicts

**Implementation ready for final acceptance:** the integrated local gates above
pass. Repository delivery still requires the final app commit's protected-branch
checks; its exact PR, revision and CI evidence accompany the delivery response.
This is source/emulator acceptance, not native compilation or production proof.

**Ready for public launch: no.** The finite remaining external checks are the
single checklist and exact-binary acceptance matrix in the linked launch record:
provider/MFA setup, matching backend/rules/importer/admin deployment, managed-runtime
proof, representative isolated cloud capacity and actual Storage generation checks,
new iOS/Android native builds and physical acceptance, and owner-only store actions.
No production deployment, shared reset, customer message or store publication was
performed as part of this repository implementation.
