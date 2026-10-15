# Board demonstration — 16 October 2026

The acceptance target is the MD's iPhone 17 running the new native TestFlight 1.0.7 candidate. Record its iOS version and exact TestFlight build number before testing. The older 1.0.5 (13) binary does not contain background tracking and cannot consume a 1.0.7 OTA.

The agreed real departure is **5503L 6, Skye & North Coast 500, 19–23 October**. On 15 October its full roster was ready with 50 booked places. Reuse the existing CBOND driver through the supported, revision-checked assignment workflow; preserve other drivers and passenger/boarding data.

## Behaviour implemented for this candidate

- Each phone independently verifies the booking reference/email, keeps the booking's existing opaque principal and receives its own app session. Version-2 authorization adds phones without replacing the previous one. Legacy authorization is promoted atomically; locked identities, wrong credentials, cancelled/absent bookings and roster-only bookings remain denied.
- Logout and administrator session revocation affect only the selected phone. Account deletion keeps its existing shared-account content scope, explains that scope before confirmation, removes only the requesting phone's authority, and does not purge a sibling phone's valid trip/session during the temporary booking-wide deletion barrier.
- Login rechecks source facts while issuing its session and rejects source changes instead of displaying a stale successful login. Missing booking scope fails closed. Driver login rejects broken/inactive assignment links before session issue; ordinary unassigned access remains supported.
- Sessions expire locally, including after returning from iOS suspension. Logout has a bounded transport deadline and retains an exact pending operation for retry.
- Location publication retains its lease through acknowledgement and uses an atomic per-tour revision/opaque epoch fence in compatibility mode as well as cutover. A delayed worker cannot overwrite an acknowledged Stop, a newer projection or a deleted/recreated tour. Admin copy/edit operations exclude these server-owned fields. Start failures remain visible after cleanup.

## Release and deployment checks

- [x] Reconcile the complete 15 October six-report source batch and next-month login/manifest data without creating customer sessions.
- [x] Exercise two real Firebase Auth emulator identities through passenger login, trip access, logout and exact administrator revocation, preserving the other phone.
- [x] Exercise actual RTDB rules for private device authorization, source withdrawal, tracking, and protected location publication metadata.
- [x] Reproduce and then prevent delayed-worker Stop resurrection and hidden Start failures.
- [x] Merge the exact reviewed candidate after required CI checks: [PR 478](https://github.com/Bondy321/llt-app-new/pull/478), `c0ed93a1b7d2cc0bf13a7e96d3b63989c0dc7595`, and the assignment recovery fix [PR 480](https://github.com/Bondy321/llt-app-new/pull/480), `043327a64cc13591e92a6d73dc851f9153f38fc5`. All six required checks passed on both reviewed branches.
- [x] Deploy all 31 affected login, media, deletion, assignment, location projection and cleanup callers, including the tracking-session trigger. Downloaded source archives match all 215 compared source files per Function. The 29 unchanged callers match `c0ed93a`; `assignDriverToTour` and `cleanupDriverLoginPolicySessions` match the follow-up `043327a`. Notification delivery retention remains paused and its Function was excluded.
- [x] Deploy the reviewed RTDB rules and initial admin build. Live rules match semantic fingerprint `886b50009ce68929ff39c21756e6f67dd70ba32e83da6ff02cc938dbe6ff020f`; scheduler states are unchanged, including the enabled 07:10 Europe/London import and paused delivery retention.
- [x] Assign CBOND to the agreed departure and verify canonical assignment/session/projection consistency. Driver and tour revisions are 1, canonical manifest assignment is present, no active barrier or incomplete transition remains, and the real Track Coaches feed shows the selected departure. Before/after hashes confirm that booking records, boarding records and all other drivers are unchanged. An earlier unsuccessful reservation was failed safely before the successful supported retry.
- [ ] Publish the date-only Track Coaches details correction after its own green merge; tour date indexes must not appear as 01:00 coach departure times. Actual GPS receipt timestamps retain UK date and time.
- [x] Build and submit native 1.0.7 (14) from exact green main revision `043327a`; Apple accepted the upload at 09:39:49 UTC on 15 October.
- [ ] Verify Apple processing completes and the candidate is available to the intended TestFlight testers.
- [ ] Record the physical results below before calling background tracking accepted.

The deployment must include older callers bundled with the previous projector: location session/pickup triggers, tracking trigger/Stop, pickup mutation, login/session end/revoke, assignment continuation/cleanup, driver-policy session cleanup, expiry cleanup and account-deletion workers. Deploying only the new Stop endpoint leaves old writers able to bypass its publication fence.

The built and submitted native release candidate is **1.0.7 (14)**, EAS build `205b1192-5c9d-4826-9ea1-0184f8584bb9`, from exact green revision `043327a`, through workflow `38713370531`. Apple accepted the upload at 09:39:49 UTC on 15 October; the build was processing when checked. The native release workflow dependency fix is [PR 479](https://github.com/Bondy321/llt-app-new/pull/479). The Apple programme agreement was accepted by the operator and its previous banner is gone. Normal distribution targets the existing LLT internal TestFlight group with six testers, including the MD. Completion of Apple processing, tester availability and the physical checks below remain unverified until separately recorded.

The selected departure's read-only reconciliation passed 25 current bookings and 50 passengers, including 23 login-eligible bookings and two valid roster-only bookings. All parties have pickup date, time, location and seats; all passenger projections and the actual driver manifest/cache round-trip pass. Its five itinerary days contain valid content. Two internal editorial warnings concern removed decorative adjectives; the native itinerary view does not display them. CBOND's phone field is blank: Call/Message actions show the existing contact-unavailable guidance rather than launching an invalid phone link.

## iPhone acceptance

1. Install the new native TestFlight build on the MD's iPhone 17. Record model, iOS version, app/build version and release commit. Confirm automatic date/time and location services are enabled.
2. Verify passenger login with a permitted real booking on the selected departure. Confirm correct tour, party, seats, pickup and itinerary readiness. On the second phone, verify the same credentials work simultaneously; log out on one and confirm the other remains usable. Do not alter bookings or boarding statuses for the demonstration.
3. Log in as the agreed driver and confirm the selected upcoming departure and full 50-person manifest. Start tracking explicitly and confirm the disclosure. Grant foreground and **Always** location access, with Precise Location enabled. If Allow Once was selected, enable Always in iPhone Settings and retry; repeated prompts cannot repair that choice in the same session. See [Expo's permission guidance](https://docs.expo.dev/versions/latest/sdk/location/#background-permissions).
4. With real feed selected in Track Coaches, confirm an actual fresh GPS timestamp. Navigate to another app screen and another app, then move outdoors with the phone locked for at least ten minutes. Record observed timestamps/cadence/gaps. The green map state alone is insufficient proof because it has a wider freshness window.
5. Disconnect/reconnect and confirm fresh coordinates recover without replaying old fixes. Press Stop and verify acknowledgement, removal of this live source and absence of later resurrection. A distinct fixed pickup or another phone's live source must remain correctly labelled.
6. Repeat Start/Stop, logout and reopen. There must be no automatic tracking restart for the wrong session or tour. Force-close is a separate platform-limit test, not proof of locked-screen operation: background delivery can stop after termination, and this app deliberately requires a fresh explicit Start after reopening. See [Expo background-location limits](https://docs.expo.dev/versions/latest/sdk/location/#background-location).

The existing labelled map demonstration remains available, but fictional positions do not establish real tracking acceptance. Genuine itinerary gaps remain visible; do not create itinerary facts for the presentation.

Aggregate code/data evidence is retained outside Git in `C:/Users/sa08b/Documents/App_Full/verification/2026-10-15`. Never put customer credentials, phone locations, raw rosters, OAuth values or private keys in release records.
