# First public launch candidate — 24 October 2026

This is one launch candidate, not a customer migration programme. Source delivery,
emulator acceptance, deployed backend acceptance and store publication are separate.
No production deployment, reset, customer notification or native publication is
authorised by this repository task. Earlier build-15 phone checks do not validate
the new native graph.

The [actor and endpoint access matrix](first-launch-access-matrix.md) records the
current data boundaries, ordinary HTTP inventory and service-only exceptions.
The [final verification record](first-public-launch-verification-2026-10-24.md)
collects runtime provenance, integrated results and the two launch verdicts.

## Supported contract

- Mobile version/runtime **1.1.0**, Expo 55, with RN Firebase app/App Check 27.0.0.
  Both platforms require a new binary. Native iOS uses App Attest with DeviceCheck
  fallback; Android uses Play Integrity. The existing Firebase JS application gets
  native tokens through its CustomProvider. All ordinary HTTP callers include
  App Check; production Functions fail closed even if an obsolete false flag remains.
- Current server-issued sessions require a committed installation authority epoch
  and exact session ID. Passenger access uses the version-2 exact UID map and keeps
  sibling phones independent. Booking-reference/email verification is **not** proof
  of mailbox possession. Missing-email passengers remain driver roster data.
- Staff ID is public identity. An authorised TOTP admin issues a short-lived,
  one-time installation enrolment secret; the server stores only its digest.
  Logout/role switch/revocation/deletion supersede approval. Device enrolment
  approves an installation, not whoever is holding it. See
  [staff contract and access matrix](../data-contracts/staff-device-enrolment.md).
- Tracking starts explicitly. HTTP RTDB source writes require the exact committed
  driver session, current staff approval/assignment and active tracking intent.
  Ordinary clients cannot write passenger-facing location/presence projections.
  Exact Stop/withdrawal and tombstone recovery remain supported.
- Passenger-trip snapshots are enabled in the production/TestFlight build contract.
  Driver Command Centre remains globally disabled; only explicitly authorised
  limited drivers may use it. A generic TestFlight flag grants no capability.
- Account deletion is server-owned only. Accepted receipts, barriers, permanent
  tombstones, unsent current actions, tracking withdrawal and pending logout are
  recovery state and must not be cleared as ordinary tester cache.
- New notification work uses `notif_v2_` identities and private delivery roots
  ending `_v2`. This isolates new consumers from delayed old queue events. Device
  and consent records remain shared, with exact session/revision/epoch publication
  fencing. Consented logged-out marketing is separate from operational membership.
- Importer source ownership, both history archives, transfer journals, fresh
  occurrence IDs, manual overlays and genuine older bookings remain intact.

## Finding evidence map

Final gate results and exact revisions must accompany this record; the existence
of a regression is not itself a claim that the final integrated candidate passed.

| Finding | Implemented correction | Retained acceptance boundary |
| --- | --- | --- |
| Staff ID as credential | One-time admin enrolment, exact device generation, TOTP admin admission | `staffAdministration`, `driverFirstClaim`, `loginEndpoints`, `sessionPublicationAuthority` |
| Queued session overwrite | Prepared/committed per-installation epoch; rules-mediated atomic publication | Genuine SDK offline queued A versus B, logout, replacement and deletion |
| Notification accounting race | Drained admitted siblings, conditional attempt versions, recoverable queue/accounting, fixed bounded ledger shards | `notificationPublication`, `notificationReliability`, SDK publication and ownership |
| Notification and safety authority | Public device deletion removed; trusted deletion worker retained; queued registration rejects all assignment markers and non-stable policy; admin safety read/action requires verified TOTP | `notificationAuthorityArrival` queued SDK checks and `loginEndpoints` real HTTP read/action, allowlist removal and disabled-user cases |
| Late local writes | Durable blocked generation and writer drain across storage scopes | Mounted `mobileLaunchBoundaries`, `mobileReliabilityJourneys` |
| F02 offline startup | Five-second network decision, exact permitted cached scope, late-result fencing | Fresh SDK pending read and mounted restore |
| F03 boarding conflict | Shared automatic/manual settlement, authoritative durable cache and mounted updates | Two-handset SDK conflict, newer local intent, restart |
| F07 durable chat | Persist immutable message/scope before clearing draft; bounded replay | Storage failure, timeout/late acknowledgement and other queue work |
| F08 tour lifecycle | Shared importer/admin lease checked at actual server commit; durable deleting/deleted state; storage generations | `tourPublication.emulator`, importer fenced publication at journal/fence/move/readiness |
| F09 Tour Pack changes | Separate immutable mutation ID and supersession key | Persist/restart, late old result, server admission and limited capability |
| F10 galleries | Stable cursor and exhaustion semantics | Genuine SDK 95+ records, equal timestamps/deleted cursor/concurrent insertion |
| F11/F12 chat media | Immediate text, bounded independent signing and exact older-target resolution | Failure, hanging signer, deletion and identity-switch tests |
| F13 route restoration | Home fallback for transient destinations lacking verified inputs | Production navigation/storage hooks after process-context recreation |
| F14 notices | Canonical current principal acknowledgement shared by push/in-app/bulk reads | Same-UID role switch and real read-state rules |
| F15 exact admin tours | Exact-record subscription takes precedence and invalidates deletion | Mounted ToursManager edits/deletion without URL change |
| App Check/MFA | Native provider bridge, HTTP headers, production guards, TOTP allowlist | Local allow/deny tests; physical provider proof remains external |
| Upload/signing authority | Decoded image limits; pending metadata; exact operation/lease/session/tour commit fence; generation-matched orphan cleanup | Queued reserve/finalize SDK tests and real-image decoder/signing races |
| Real account deletion | Source/variant object generations, bounded chat pages, exact device removal, Auth last | `accountDeletionContent.emulator` uses actual disposable Storage bytes |
| Resource limits | Shared UID/network API quotas, project push budget, bounded lane progress | `distributedRequestLimiter`, read/notification scale harnesses |
| Publication | Push OTA disabled first; manual exact-SHA CI + prerequisites gates | Release workflow and native compatibility tests |

The integrated cold-SDK regression exposed a real projection defect: concurrent
`get()` and `once()` calls on the same staff-policy path triggered Firebase's
`listen() called twice` assertion. The full stack was retained in
`verification/2026-10-24-first-public-launch/login-endpoints-cold-stack.log` outside
the repository. Chat/location projection reads now consistently use `once()`;
authority checks and concurrent independent SDK triggers remain intact. The
strengthened test publishes an explicit tracking intent, proves live chat and
coach location, then proves logout withdrawal and immediate re-login. The repaired
login/cleanup/deletion-admission SDK batch passed **48/48**, with **zero skips or
cancellations**, and projection units passed **30/30**; scoped lint was clean.
These are focused local results, not final integrated CI or deployed acceptance.

## Native and admin provider setup

Read-only Firebase inventory during this task found iOS app
`1:500767842880:ios:eaedd7a6ee4c6ca0a4f5a5` and web app
`1:500767842880:web:b27b5630eed50e6ea4f5a5` in `loch-lomond-travel`.
**No Android Firebase registration was present.** Recheck before acting.

Read-only Google Play Console verification on 24 October showed the LLT personal
developer account has **no app created** and Create app is disabled. It explicitly
requires Android-device verification through the Play Console mobile app and
contact-phone verification; the latter depends on completion/approval of the other
identity checks. Complete those owner actions before creating the Android listing.
App Store Connect returned a blank page in this session, so Apple account,
agreements, privacy and final candidate availability are **not freshly verified**.

Owner preparation, before any enforcement deployment:

1. Register the exact Android package `com.lochlomondtravel.tourapp`, attach the
   Play signing SHA-256 certificate and configure Play Integrity/App Check.
   Configure the existing iOS identity for App Attest/DeviceCheck, Apple entitlement
   and production signing. Supply `GOOGLE_SERVICES_JSON` / `GOOGLE_SERVICES_PLIST`
   as EAS file values for the correct platform/project. The remote pre-install
   check validates identity and fails if configuration is missing or mismatched.
2. Configure a reCAPTCHA Enterprise web key and authorised admin domains; supply
   `VITE_FIREBASE_APPCHECK_SITE_KEY`. Web passenger builds require their matching
   `EXPO_PUBLIC_APPCHECK_WEB_SITE_KEY`. Do not use debug tokens or fake site keys.
3. Enable Firebase Authentication with Identity Platform TOTP MFA support, verify
   admin email, enrol authenticator, then sign in with the second factor. Test a
   recovery path under the account owner's control before enforcing the rules.
   Enrolment alone does not put the second-factor claim into an existing session.
4. Verify actual production-provider tokens from **both intended binaries** and
   the admin origin, through a protected HTTP endpoint and RTDB request. Invalid,
   expired and missing tokens must be rejected. Do not log token values.

Normal admin build fails without the real key. CI uses explicit
`npm --prefix web-admin run build -- --mode verification`, writing only
`verification-dist`; it is compilation evidence, not a deployable accepted admin.

Official implementation references checked against the installed API:
[RN Firebase App Check](https://rnfirebase.io/app-check/usage),
[RN Firebase native/Expo setup](https://rnfirebase.io/),
[Firebase JS CustomProvider](https://firebase.google.com/docs/app-check/web/custom-provider).

## One first-launch preparation checklist

- [ ] Final app and importer PR heads pass every required gate, with exact logs and
  counts. CI uses Bash-only checkout and local composite actions: checksum-pinned
  Node 24.22.1/22.23.4 passes the unchanged certificate-trust guard before installs.
  No JavaScript action runtime is invoked and no provider-owned binary is modified;
  this avoids that runtime, without claiming GitHub has patched it. Confirm the
  exact event SHA, all six app checks, and importer fresh pinned-container
  trust/HTTPS and mandatory SDK tests without skips. Provider-managed EAS and
  serving-image proof remains separately required.
- [ ] Review matching Functions, RTDB/Storage rules, importer image and admin build
  from those exact revisions. Prepare `live_state_rollout/v1` with schemaVersion 1,
  phase `cutover`, positive projectionRevision/updatedAtMs, and
  `account_deletion_rollout/v1` with schemaVersion 1, phase `server_only`, positive
  revision/updatedAtMs. Existing explicit compatibility records fail closed.
- [ ] Keep Command Centre global enablement false and inspect exact driver exceptions.
  Set passenger snapshot flag true. Register providers/MFA as above; verify tokens
  before activating enforcement. Confirm service regions, quotas and credentials.
- [ ] Stop and drain obsolete notification consumers before activating v2 writers.
  Preserve private old delivery/accounting evidence and all consent/security records.
  No shared reset was executed. Review the dry-run manifest below; never infer
  synthetic data from dates, missing email or missing sourceRoster metadata.
- [ ] Activate reviewed monitoring policies/contact channels and cost alerts; confirm
  hard max-instance/provider bounds. Billing alerts are not spending caps.
- [ ] In an authorised disposable Cloud Storage bucket, verify actual generation
  enforcement: a delayed `ifGenerationMatch: 0` upload must return 412 after its
  zero-byte cancellation marker exists, and an old generation-matched delete must
  return 412 after replacement. Retain the replacement and remove only synthetic
  fixtures. Local Storage content tests do not prove these provider semantics:
  the installed Firebase emulator does not implement those preconditions.
- [ ] Build matching iOS/Android 1.1.0 binaries explicitly. Record EAS build ID,
  commit, runtime, channel, native provider identity, OS/device and backend revision.
  Every manual build/update/submission installs all three dependency graphs before
  its release audit. TestFlight submission independently rechecks exact-commit CI
  and the authenticated EAS artifact: finished physical-device iOS store build,
  exact project/bundle/version/runtime, and the production-backed `testflight`
  profile/channel. Reusing a build does not skip these checks; missing provenance
  fails closed. These metadata checks do not replace native App Check/device tests.
  Confirm store ownership/verification, privacy/data-safety disclosures, location
  permission explanation, support/deletion URLs and account-deletion availability.
- [ ] Complete the exact-binary phone record below; then explicitly approve publication.

## Exact-binary phone acceptance record

All rows initially **unperformed for 1.1.0**. Fill with actual evidence, not old
build-15 results. Required identifiers: app commit, importer revision/image,
backend/rules revision, iOS/Android build IDs, OS version and physical device.

| Journey | Expected result | iOS evidence | Android evidence |
| --- | --- | --- | --- |
| Fresh passenger and enrolled driver login | Wrong credentials denied; correct tour/roster; onboarding and permission refusal usable | Pending | Pending |
| Two passenger phones and logout | Each current phone independent; exact logged-out device loses server authority | Pending | Pending |
| Driver revoke/shared phone switch | Immediate privileged denial; public ID cannot re-enter driver mode | Pending | Pending |
| Cold offline/reconnect/process death | Bounded decision, permitted scope only; chat/boarding/cache/server converge | Pending | Pending |
| Tracking Start/locked movement/loss/recovery | Fresh acknowledgements and independent passenger/admin map evidence | Pending | Pending |
| Stop pending/offline, force-close, reassignment | No resumed sharing without fresh Start; old samples rejected | Pending | Pending |
| Group/private media and older push | Beyond60 accessible; failed image does not hide text; unread owner correct | Pending | Pending |
| Real-content account deletion | Retry/status recovery; owned content removed; business data/sibling retained | Pending | Pending |
| Admin MFA, edits, assignment, manual roster-only addition, synthetic tour deletion | Current exact record; conflict/retry safe; no stale resurrection | Pending | Pending |

## Tester reset preparation

`config/first-launch/tester-reset.dry-run.json` is intentionally non-executing.
No production UID has been independently proved synthetic in this task, so its
allowlist is empty. `D-CBOND` is an identifier, not proof that every linked record
is disposable. Owner review must identify exact UIDs and provenance before adding
anything. Ordinary local tester cache can require sign-in; preserve durable
pending actions, logout/deletion/withdrawal state and all permanent evidence.

## Storage generation evidence boundary

Cloud Storage's documented [request preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions)
make generation-zero uploads conditional on no current object and return 412 on
generation mismatch. Production source/variant writes and deletion retain these
conditions. Permanent empty cancellation markers prevent old create requests from
restoring customer bytes; they contain no image content. Local tests separately
cover actual nonempty Storage deletion and generation-faithful adapter races.
The Firebase Storage emulator lacks `ifGenerationMatch` enforcement, so a real
disposable bucket check above remains necessary before public-launch acceptance.

## Bounded read workload evidence

`node scripts/launchReadScale.js` uses production credential/source lookup,
current-session verification, passenger snapshot, manifest (10% of journeys)
and group-media lookup (20%) against a synthetic indexed in-process adapter.
It rejects live network connections. The population contains 60,000 synthetic
bookings/installations across 800 tours with 75 bookings each. The concurrency
and request totals below are test inputs, not a forecast of customer behaviour.

Predeclared local targets: p95 below 1,000 ms, at most 100 reads per journey,
at most 75 records per indexed query, peak RSS below 1 GiB, and zero errors.
The 150-record baseline and the 60,000-record normal workload both performed
11,080 reads and read exactly 4,592,529 serialized JSON bytes for 200 journeys.
Unrelated population therefore did not increase per-request database work.

| Workload | Journeys / concurrency | p50 / p95 / p99 (ms) | Reads | Serialized read bytes | Peak RSS (bytes) | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| Small baseline (150) | 200 / 10 | 6.78 / 11.71 / 14.64 | 11,080 | 4,592,529 | 62,320,640 | 0 |
| Normal (60,000) | 200 / 10 | 6.34 / 28.10 / 29.56 | 11,080 | 4,592,529 | 464,797,696 | 0 |
| Launch burst (60,000) | 500 / 50 | 22.95 / 35.68 / 38.96 | 27,700 | 11,486,711 | 678,080,512 | 0 |
| Reconnect storm (60,000) | 1,000 / 100 | 65.89 / 95.31 / 122.85 | 55,400 | 22,976,852 | 659,726,336 | 0 |

All workloads averaged 55.4 reads/journey; the largest read was 17,792 bytes and
the largest query returned 75 records. These are local computation and adapter
measurements, not RTDB wire/billing quantities or cloud latency. They do not
measure Auth token issuance, session-publication writes, distributed quota
contention, TLS, object signing or deployed throughput. The executable harness
and the notification workload record in `../performance/notification-launch-capacity.md`
provide reproducible local evidence; representative isolated cloud capacity
remains a launch condition.

## Import history correction

The October 23 certificate record accurately describes its earlier blocked import.
Subsequent PR6 recovery is recorded in the task handover: execution
`llt-app-sync-daily-92xwj` completed at 12:19:47 UTC, with 514 current tours,
5,459 bookings, 14,866 passengers and 12 transfers; non-source fields of 25,145
pre-existing bookings preserved. This task does not rerun that import or claim a
new live measurement. The security rebuild and later transfer-code change are
different revisions; the itinerary catch-up override is not a permanent limit.
