# Loch Lomond Travel launch task list

Created: 8 October 2026

Prepare the existing passenger and driver app for a supported trial on one tour, then release matching iOS and Android versions. For each fix: implement, run the required checks, commit and push directly to GitHub main. Keep deployment and live verification concise, and distinguish code on main from changes already running in production. Public store release and passenger invitations follow the launch decisions.

## Agreed launch scope

- Existing passenger features and existing driver tools.
- Location sharing continues while the phone is locked or another app is open, during an explicitly started driver tracking session.
- A new **Track Coaches** section in the web admin.
- Android distribution through Google Play alongside an updated iOS release.
- Driver Command Centre remains limited: keep the global flag off. Its current TestFlight eligibility must not automatically expose it to passenger or driver pilot cohorts.
- A trial on one real tour before the wider rollout.

## Work that can run alongside the code fixes

- [ ] **Google Play account:** finish pending identity verification, physical Android device verification and contact phone verification. The current account is personal; confirm company ownership and plan conversion to an organisation account if appropriate. Conversion requires the personal account to be fully verified first.
- [ ] **Test devices:** borrow an Android for verification, arrange ongoing access to a supported Android phone and an iPhone, and use an emulator for development where useful.
- [ ] **Pilot tour:** choose the departure, participating drivers and passenger cohort. Recruit Android testers and record their Play Store account emails separately from their booking emails.
- [ ] **Public web pages:** establish where the app privacy policy and account deletion request page will be published.

For a new personal Play account, public release requires a closed test with at least 12 testers continuously opted in for 14 days, followed by production-access approval. Plan 15–20 Android participants for margin; iPhone testers do not count. A shorter tour can fit within the 14-day test period. Use closed testing for this requirement; internal testing is suitable for the earlier staff checks.

Sources: [Play device verification](https://support.google.com/googleplay/android-developer/answer/14316361), [personal account testing](https://support.google.com/googleplay/android-developer/answer/14151465), [organisation account conversion](https://support.google.com/googleplay/android-developer/answer/16260648).

## 1 Repair imported tour dates

Confirmed issue: the 7am TourSummary reports include UK dates with a midnight time suffix. The importer rejects formats such as `23/10/2026 00:00:00` and `12/10/2026 0:00:00`, leaving raw dates without the indexes the admin current-tour query needs. The live dashboard reports 1,173 active tours with invalid or missing start dates; this count is an investigation snapshot, not a count of current departures.

- [x] Fix and regression-test `llt-app-sync/src/models.py` using the exact report strings and invalid-date cases.
- [x] Check parsing, calculated end dates and index consistency across the importer, backend and admin date contracts.
- [x] Produce a bounded dry-run repair showing affected tour fields and counts. Preserve human-edited itineraries and runtime operational data.
- [ ] Apply the reviewed repair and reconcile derived indexes through the existing supported maintenance path.
- [ ] Verify representative current and future tours in the admin and app, then confirm the next scheduled 7am import preserves valid dates.

Complete when: the affected departures have valid canonical dates and indexes, the current-tour view includes them, and a subsequent import does not recreate the problem.

References: [date contract](date-contract.md), [admin date contract](date-contract-web-admin.md).

## 2 Resolve dependency audits and establish stable tooling

Confirmed issue: the initial checkout failed its security audit gate across mobile, Functions and admin dependencies. Counts include shared dependency chains and build tooling. Crash investigation is deferred at the user's direction on 8 October; its separate local changes are preserved outside this dependency change.

- [x] Trace the high and critical advisories to installed packages and choose compatible updates or a justified, reviewed resolution. Avoid forced downgrades from `npm audit fix --force`.
- [x] Update affected lockfiles and pass the release audit and complete app regression suite. Firebase integration checks remain required in CI.
- [x] Verify a clean dependency install and matching Expo package versions, without a forced framework downgrade.
- [x] Keep verification resource use bounded and pass the complete required checks before merging to main.

Complete when: the audit gates, SDK compatibility, clean installation and required regression checks pass on the final dependency graph. Report any lower-severity development-tool findings explicitly.

Dependency baseline: [implementation and verification notes](dependency-stability.md). Functions/admin raw audits are zero; the mobile build toolchain's unreleased fixes are source-verified. One moderate development-only telemetry advisory remains visible.

## 3 Fix location publication and withdrawal

Confirmed issue: the mobile location service reads its private source after writing it and uses a read-dependent transaction during withdrawal, while deployed rules deny client reads of that source. The service/rules combination reproduces publication errors and a withdrawal that reports success without removing the source.

- [x] Fix `services/driverLocationService.js` to use operations permitted by the current ownership contract.
- [x] Preserve exact session ownership and protection against old callbacks removing newer sources.
- [x] Add a regression test exercising the actual service against the emulator rules, covering publication, withdrawal and multiple devices.
- [x] Verify logout, reassignment, expiry and passenger projection cleanup through service/rules integration and backend regression tests. Physical-device release acceptance remains in stage 8.

The switch now stops local updates immediately and retains the exact retired session for failed-removal retries. Server acknowledgement is distinguished from the estimated UI timestamp and asynchronous passenger projection. This stage changes mobile JavaScript only; it does not deploy rules or Functions, change the compatibility phase, or introduce background tracking.

Complete when: valid writes succeed, owned sources are actually withdrawn, and another session or device cannot overwrite or remove them incorrectly.

Reference: [driver location contract](data-contracts/driver-location.md).

## 4 Add explicitly started background tracking

The app now owns explicitly started tracking sessions across navigation. iOS uses background location with Always access; Android uses a visible service started while the app is open. This requires new version `1.0.7` binaries and backend/rules deployment before device acceptance.

- [x] Define the driver Start tracking and Stop tracking flow, persistent status and permission explanations.
- [x] Move session ownership out of the Driver Home screen and implement supported iOS and Android background location handling.
- [x] Handle permission denial or revocation, offline connectivity, session expiry, reassignment, logout and interrupted execution truthfully.
- [x] Stop sharing on explicit stop and authority loss; prevent tracking resuming for the wrong driver or tour.
- [x] Update native permissions, background modes, release configuration and the app/runtime version required by the compatibility guard.
- [ ] Deploy tracking rules, stop endpoint and projection/cleanup Functions; build the matching native apps.
- [ ] Verify movement, locking, navigating within the app, switching apps and battery restrictions on real devices. Document force-stop and OS termination limitations.

Complete when: a driver can explicitly start and stop a session, authorised updates continue during supported background operation, and stale or interrupted tracking is clearly reported.

References: [driver location contract](data-contracts/driver-location.md), [release compatibility](release-compatibility.md), [device acceptance](operations/driver-tracking-acceptance.md).

## 5 Build Track Coaches in the web admin

- [x] Add a lazy-loaded navigation section consistent with the existing admin UI and service boundaries.
- [x] Use an authorised, bounded data path that covers the fleet without silently truncating it to the existing 500-tour directory limit.
- [x] Join locations to current tour assignments. The existing public projection selects one source per tour; do not label it as independent tracking of every driver or coach.
- [x] Provide a map and accessible list with tour and driver context, last update time, accuracy and live, recent, stale or unavailable states.
- [x] Distinguish a fixed published pickup from a live position and avoid presenting expired coordinates as current.
- [x] Resolve map provider configuration, attribution and Hosting content security policy compatibility.
- [x] Test loading, empty, error, reconnect, multiple-tour and mobile-width views, including browser verification.

- [x] Deploy the map rules, projection Functions and initial feed, then verify the live admin and labelled board demo.

Live verification on 9 October 2026: six source tour candidates reconciled; the
authenticated real feed showed six tours and zero fresh live GPS positions.
An isolated, inactive synthetic tour verified deployed event-driven publication
and withdrawal, then was removed. Demo mode showed eight explicitly fictional
tours without writing them to Firebase. Notification retention remained paused
at revision 8; native background device acceptance remains in stage 4.

Complete when: an admin can reliably identify which tracked tour each marker represents, its freshness and its tracking state, with accurate assignment changes and no silent fleet omission.

## 6 Complete Android integration and staff testing

Confirmed gap: Firebase currently has iOS and web registrations, but no Android app registration. Android native push configuration needs to be established and tested.

- [ ] Register the Android app with the existing package identity and configure the native Firebase file and FCM credentials through supported secret/configuration paths.
- [ ] Verify Google Maps configuration, permission behaviour, signing, EAS credentials and Play App Signing requirements.
- [ ] Verify the final bundle target SDK against the current Play requirement and remove unnecessary media permissions where supported by the app flows.
- [ ] Prepare a new Android build from current Expo configuration, then distribute a staff internal-test build through Play.
- [ ] Test installation, updates, passenger and driver login, maps and real notification delivery on Android.

Complete when: the release candidate installs through Play, the correct backend and environment are selected, and Android maps and notifications work on a physical device.

## 7 Align release configuration and store information

- [ ] Decide whether to include the existing passenger-trip snapshot controller after acceptance testing; its production environment flag is currently absent. Carry the chosen setting consistently through build, OTA and workflow configuration.
- [ ] Confirm driver feature flags for staff testing, passenger pilot and production separately, preserving the limited Command Centre scope.
- [ ] Publish an app-specific privacy policy at a public HTML URL and provide the external account deletion resource required for the applicable Play account model.
- [ ] Reconcile Apple privacy answers and Play Data safety with actual collection, identity linkage, retention and the new background tracking flow.
- [ ] Update purpose strings, store descriptions, screenshots, review notes and supported reviewer credentials/data.
- [ ] Select matching new release binaries. The current public Apple binary is 1.0.2 build 7; newer-runtime OTA updates cannot upgrade its native runtime.
- [ ] Refresh older release documents where they conflict with the final implementation or live release configuration.

Complete when: store declarations and in-app information match the actual build, and both stores have usable review access and coherent version/runtime settings.

## 8 Verify the release candidates

- [ ] Run targeted checks during each implementation stage, then the complete repository verification pass before pilot sign-off.
- [ ] Pass contract generation/parity, architecture, lint/type checks, release configuration and native compatibility checks as applicable; build the admin. Run rules and login emulators for affected boundaries.
- [ ] Resolve the admin suite timeout seen in the initial review or establish a reliable passing complete run; an isolated rerun is not full-suite sign-off.
- [ ] Run physical iPhone and Android acceptance for fresh install, upgrade, login, assignment changes, itinerary, manifests, boarding, chat, photos, notifications, Find My Bus and background tracking.
- [ ] Exercise offline recovery, reconnect, session expiry, logout, reinstall/device recovery and account deletion using appropriate test identities.
- [ ] Confirm the 7am sync and deployed backend compatibility. Inspect notification delivery and cleanup health; keep the paused notification retention job paused unless its preparation and canary protocol justify a separate activation.
- [ ] Record exact source revision, binary versions, runtime versions, environment, deployed backend/rules and device results. Deploy reviewed backend access changes in the documented order.

Complete when: all required checks pass for the actual pilot candidates and each remaining limitation has an explicit disposition.

Reference: [notification retention operations](operations/notification-retention.md).

## 9 Run the one tour pilot

- [ ] Release the verified closed-test Android build and an appropriate passenger/driver TestFlight cohort after pilot approval.
- [ ] Provide short installation and login instructions, collect informed participation and establish a feedback/support route.
- [ ] Verify the intended drivers and passenger bookings before departure and retain normal tour support arrangements.
- [ ] Observe tracking freshness and battery use, pickup accuracy, onboarding, offline reliability and notification delivery during the tour.
- [ ] Record feedback and fix pilot blockers. Repeat affected checks after each change.
- [ ] If retaining the personal Play account, confirm at least 12 closed testers remain continuously opted in for the required 14 days before applying for production access.

Complete when: the real-tour results support launch, identified blockers are resolved, and the applicable Play testing requirement is satisfied.

## 10 Submit and verify public release

- [ ] Prepare final matching release candidates, store metadata and a concise launch approval summary after pilot fixes.
- [ ] Obtain explicit approval for store submission and public release; apply for Play production access where required.
- [ ] Submit the iOS update and Android release, resolve review feedback and retain a documented rollout/rollback plan.
- [ ] Verify public availability and fresh-install behaviour through both stores.
- [ ] Check the first production import, tracking and notification behaviour after release.

Complete when: the intended versions are publicly available, fresh installs work, and initial live operational checks pass.

## Current progress

Stage 1 ingestion fixes, date-index concurrency hardening and repair tooling are implemented locally. The 8 October preview covers 2,136 tours and 8,817 changed date fields, with six historical end-date conflicts excluded. Deployment, reviewed live repair, admin/app verification and the next morning import check remain open. See `llt-app-sync/docs/tour-date-repair.md` for the rollout and repair procedure.
