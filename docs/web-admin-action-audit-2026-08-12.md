# Web admin action audit - 2026-08-12

## Scope and conclusion

This audit traced every interactive operation exposed by `web-admin` through its Firebase write or HTTPS Function and then to the mobile app read path or operational effect. The portal is wired to the same `loch-lomond-travel` Firebase project as the mobile app. All operational actions below have an implemented backend path, authorization enforcement, failure handling, and automated coverage. Read-only navigation, filtering, previewing, and CSV download do not mutate Firebase.

Production smoke testing is deliberately non-destructive: authenticated page loading and live reads are exercised in production, while mutations are verified with unit, integration, Function, and Firebase Realtime Database emulator tests.

## Action matrix

| Portal action | Backend effect | App or operational effect | Safeguard and verification | Status |
| --- | --- | --- | --- | --- |
| Sign in | Firebase Auth email/password session, followed by an operations-admin authorization check against the primary UID or `admin_users/{uid}` | Grants access to the portal only; it does not alter customer data | Fails closed and signs out authenticated non-admin users; covered by `adminAuthService.test.js` and database-rule tests | Verified |
| Reset password | Firebase Auth password-reset email | Account recovery only | Firebase controls delivery; generic success copy avoids disclosing whether an address is registered | Verified |
| Sign out | Firebase Auth session termination | Revokes portal access on that browser | Auth-state listener returns the portal to the login screen | Verified |
| Change password | Reauthenticates with the current password, then calls Firebase Auth `updatePassword` | Secures the administrator account only | Requires current password, matching confirmation, and an eight-character minimum | Verified |
| Dashboard refresh | Re-reads `drivers`, `tours`, `tour_manifests`, broadcasts, safety alerts, and curated operations alerts | Refreshes the operational view without changing app data | Per-branch loading/error state and bounded alert queries | Verified |
| Acknowledge or resolve an operations alert | Updates the matching `ops_alerts/{id}` status and timestamps | Changes the live operations queue; does not change customer content | Rules restrict writes to operations admins; authenticated admin UID is recorded in `statusUpdatedBy` | Verified |
| Acknowledge or resolve a safety alert | One root multi-path update changes global, tour, and private safety-log mirrors | The dashboard and the reporting user's durable safety record converge on the same status | Rules prevent passengers or outsiders from changing status; 74-rule emulator suite covers participant creation and admin-only transitions | Verified |
| Create a driver | Transactionally creates `drivers/{driverCode}` | Makes the canonical driver profile available for assignment and driver login/claim flows | Normalized code; transaction refuses replacement of an existing driver | Verified |
| Edit driver details | Updates the canonical driver profile and linked display data | Updated name/phone is used by tour assignment, contact, and driver-facing screens | Admin-only driver writes; assignments remain canonical rather than display-name based | Verified |
| Assign a driver | Atomic root update synchronizes `drivers`, `tours`, `tour_manifests`, and canonical user assignment fields, while removing stale assignment links | Driver login resolves the new tour; passenger tour/contact views see the assigned driver | Reassignment cleans the previous tour and stale manifest entries; delegated-admin rule test exercises the full update shape | Verified |
| Unassign a driver | Atomic root update removes canonical assignment links and resets tour driver display to TBA | Driver becomes unassigned and the tour is shown as needing assignment | Uses the same canonical multi-path assignment contract as the mobile service | Verified |
| Create a tour manually or from a template | Creates `tours/{normalizedTourCode}` with validated dates, capacity, pickup points, and an empty or template itinerary | Tour becomes readable by assigned/verified mobile users and available to bookings/assignments | Duplicate code check, immutable tour-code contract, chronological-date validation, strict pickup parsing, and zero derived passenger count | Verified |
| Edit a tour | Updates allowed tour definition fields | Mobile tour, pickup, date, capacity, and itinerary consumers receive the realtime change | Tour code cannot be changed; capacity cannot fall below trusted booked count; derived count is read-only | Verified |
| Duplicate a tour | Creates a new unique tour containing reusable definition fields only | Provides a clean new tour without leaking participants, alerts, tracking, bookings, or driver assignment | Tests assert all live operational state is omitted and participant count resets to zero | Verified |
| Delete a tour | Authorized `deleteTourData` Function removes tour-scoped database records, bookings, manifests, assignments, reports, safety copies, chats/photos metadata, and Storage objects | The deleted tour and its associated customer/driver data disappear consistently | Confirmation dialog, admin bearer token, server-side admin check, per-tour deletion lock, idempotent retry behavior, and deletion-plan tests | Verified |
| Export tours | Creates a local CSV download from the current live tour and canonical driver data | No app mutation | Browser-only download; current participant total is exported as reporting information | Verified |
| Import tours | Dry-run parser creates or field-preservingly updates tours, with optional canonical driver assignment | Valid imported fields appear in the same mobile tour paths as ordinary edits | Required headers, quoted/multiline parser, mode checks, date/numeric/pickup validation, duplicate detection, driver-ID validation, per-row result reporting; exported Current Participants is explicitly read-only and ignored | Verified |
| Add passenger booking | Authorized `createManualPassengerBooking` Function atomically writes booking, login identity, pickup data, manifest row, and trusted booked-participant counts | Passenger can log in with the new booking; driver manifest and tour capacity immediately include every passenger/seat | Server validates tour state/dates/capacity, booking uniqueness, email, pickup, passenger details, duplicate/existing seats; booking and tour locks protect concurrency | Verified |
| Send a tour broadcast | Writes a queued record at `broadcasts/{tourId}/{broadcastId}`; Function fan-out updates delivery status/counts and durable tour notification feed | Eligible users on that tour receive push delivery; app notification inbox receives the durable notification | Explicit confirmation, in-flight duplicate guard, authenticated creator UID, assigned-tour validation, token dedupe/sender exclusion/invalid-token cleanup, delivery status history | Verified |
| Send a category broadcast | Writes `category_broadcasts/{category}/{broadcastId}`; Function targets canonical/legacy tour-interest opt-ins | Opted-in users receive future-tour/category alerts | Supported-category validation, explicit confirmation, admin rules, recipient preference tests, delivery result tracking | Verified |
| Review/dismiss/action a content report | Updates `content_reports/{reportId}` status and timestamps | Removes the report from the active moderation queue while retaining history | Only supported status values; bounded live report subscription; operations-admin rules | Verified |
| Permanently remove reported chat content | Atomic root update deletes the canonical chat/internal-chat message and actions its report | Message disappears from the relevant app chat | Confirmation dialog; path is derived from trusted report fields and cannot be supplied by the reporter; allow-listed canonical path formats | Verified |
| Permanently remove a reported group photo | Authorized `removeReportedPhoto` Function deletes source/generated Storage objects, removes database metadata, and actions the report | Photo disappears from the group album and Storage | Confirmation dialog, bearer token, server-side admin check, report re-read, supported group-photo-only validation, canonical path derivation, retry-safe cleanup | Verified |

## Cross-cutting integrity changes made during the audit

- Portal access now requires operations-admin authorization, not merely any Firebase-authenticated account.
- Delegated operations admins have the exact collection and assignment-field permissions required by the UI without receiving broad user-record or admin-roster write access; only the primary owner can grant or revoke admin roles.
- Manual passenger creation updates all login, booking, manifest, pickup, and trusted count records in one root transaction-shaped update and rejects over-capacity bookings.
- Safety status changes update the global, tour, and private mirrors atomically and record the acting admin UID.
- Reported-content removal ignores reporter-controlled source paths and derives only canonical paths.
- Broadcast and destructive moderation actions require confirmation; broadcasts also reject duplicate submissions while a send is in flight.
- Ordinary forms and CSV import cannot hand-edit the booked-participant count.
- Production Firebase diagnostic listeners/logging are disabled unless explicitly enabled, and sensitive identifiers are redacted.
- Portal routes are lazy loaded and Firebase, React, Mantine, and icons are separated into stable production chunks.
- SPA documents and rewritten routes are served non-cacheable while hashed assets
  retain one-year immutable caching; CSP and browser capability headers harden
  the deployed admin surface.
- Tour selectors cap the rendered result list at 50 while remaining searchable,
  avoiding a 1,623-option DOM expansion on current production data.

## Verification record

- Fast release gate: 250 passing checks across mobile auth/sync/booking/date behavior and web-admin components/services/utilities.
- Extended mobile and backend gate: all suites passed, including 43 Function/script checks.
- Realtime Database and Storage emulators: 82 passing authorization and validation checks.
- CSV import regression suite: 7 passing checks, including read-only participant totals.
- Web-admin ESLint: clean.
- Vite production build: successful.
- Production portal smoke: all authenticated routes rendered live data without console warnings/errors; security/cache headers and admin Function CORS behavior matched the release contract.

## Residual operational considerations

- Production smoke tests avoid sending real broadcasts, changing real assignments, deleting real content, changing the admin password, or creating test bookings. Those mutation paths are exercised against mocks/emulators and through server-side validation tests instead.
- Tour creation uses an RTDB transaction that commits only when the canonical tour ID is absent, so concurrent admins cannot overwrite one another when they submit the same tour code.
- Storage deletion and database removal cannot form one cross-product transaction. Deletion Functions are designed to be retried safely if Firebase Storage or Realtime Database fails partway through, and failures are not presented as success.
