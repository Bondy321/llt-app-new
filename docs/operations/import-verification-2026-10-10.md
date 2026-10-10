# Morning import and passenger-count verification — 10 October 2026

## Import delivery

Scheduled Cloud Run execution `llt-app-sync-daily-t2wht` completed successfully
at 06:11:21 UTC (07:11 BST). It acknowledged 18 requests and 2,079 paths across
`tours`, `bookings`, `booking_identities` and `pickupPoints`. The 07:10
Europe/London schedule remains enabled; the legacy 09:00 and 13:00 schedules
remain paused.

An explicit read-only pull of the 7am reports contained 524 tours, 5,109
bookings, 5,431 identity rows, 373 pickup groups and 13,396 passenger occurrences.
TourSummary contained 13,698 sold places. A UTF-8 production comparison found
all source tours and bookings present, no imported scalar/identity differences,
no pending passenger/pickup merge changes, and zero eligible date repairs.
The six conflicting historical date records remain excluded. The date index
contained 541 current/upcoming records, including retained records; the admin
continues to label its bounded 500-record window and exact-code lookup.

## Passenger count repair

The admin had displayed runtime `currentParticipants` (usually zero) in place
of imported booking counts. PR 470, main commit `37d87af`, gives TourSummary
`sold` precedence, followed by imported booked/manifest counts and validated
legacy fallbacks. Present zero is authoritative. Cards, details, table,
view totals, CSV exports and dashboard projections follow the same policy.
Sold-versus-passenger-report differences remain visible rather than being
silently reconciled. Capacity cannot be reduced below booked places.

All six required CI gates passed. Production Hosting and all 20 tour-recomputing
dashboard Functions were deployed together, including three new count triggers.
Live DOM verification showed 13,296 booked places in the loaded 500-record
window and counts of 30 and 22 on the first two displayed tours. These are
window totals, not the full report total. No browser console errors were
observed after reload. Browser screenshots and pointer interactions were
unavailable because the in-app browser had no active rendered viewport;
table/details/CSV behaviour is covered by automated component/service tests.

Dashboard maintenance resume also revealed that an RTDB transaction initially
sees an empty local cache after `once()` releases its listener. A nonzero
progress revision therefore aborted before contacting the server. The fix
retains a hydrated value listener through the unchanged revision/cursor CAS,
then detaches it. Actual emulator tests cover fresh-client resume, competing
revision/cursor/deletion, and cleanup. This changes only the maintenance tool;
it does not need another Function deployment.

## Remaining roster risks

The importer matches its inputs, but its pickup report is not a complete roster.
The separate exact 7am TourPax file `XPO_SCHED_TourPax_20261010_070018.csv`,
filtered to source tour code and departure date, contained 13,708 occupied rows
with booking references across 5,211 bookings. All 13,396 pickup-report rows
matched it. Another 312 roster rows were absent from both the pickup report
and live app data. There were also 361 named rows without booking references
whose operational meaning has not been established.

The actual live manifest helper returned 14,295 normalized rows across 5,343
bookings for these source tours: 899 additional rows compared with the current
pickup report (403 within current bookings and 496 in 234 absent-report
bookings). None matched the additional TourPax rows by booking, tour, normalized
name and seat. Neither report includes cancellation status or stable passenger
IDs. The user is unsure whether TourPax is authoritative for cancellations;
absence alone is not permission to delete old or manually entered passengers.

One retained booking normalized to 109 passengers. The actual mobile driver
cache validator rejected its whole tour at the 80-passenger booking limit;
523/524 source-tour snapshots passed. The passenger safe projection caps this
booking at 100, omitting nine rows. Correct roster ownership/reconciliation
before raising limits or deleting records.

260 current-source bookings lacked a usable live email identity. Today's
262 blank-email bookings explain these, with two valid older emails preserved.
The parser's two warnings cover the sold/roster discrepancy (17 tours) and blank
email rows; they are not parser errors. Ten tours have sold places but zero
pickup-report passengers. 136 live customer itineraries contain placeholders
only; readable objects and preserved hashes do not prove prose suitability.

## Tracking and acceptance boundaries

All observed failed tracking/dashboard import events subsequently returned
HTTP 200; the 112 stderr entries were lock contention, not observed permission
or query failures. The tracking feed was ready, with all six source-eligible
assignment/location rows matching their source fingerprints and no overflow.
It covers tours with assignments or valid location sources, not all scheduled
tours. The source/projection snapshot was non-atomic.

Server Command Centre flags remain globally disabled and TestFlight enabled;
binary build-time cohort eligibility was not verified. No real app sessions,
GPS movement, native offline persistence or notification delivery were created
by this audit. Physical-device acceptance remains outstanding.

Next work: establish the full roster and cancellation semantics, explicitly
separate source-managed and operator-managed rows, then implement and verify
bounded reconciliation without losing boarding/runtime state. Resolve pilot
booking login coverage and itinerary suitability before passenger invitations.
