# Manual Passenger Creation Contract

Web admin can add a booking manually through the `createManualPassengerBooking` Cloud Function.

## Purpose

This path is for rare operations/admin use, including creating a test passenger account for app review. It must produce a booking that behaves like a normal sync-uploaded booking in the passenger app.

## Required input

- Existing active `tourId` selected from web admin.
- Unique booking reference.
- Optional login email address. A valid email enables passenger login; a blank email creates an operational roster entry only.
- Pickup date, time, and location.
- One or more passenger rows, each with full name, seat number, and phone number.

## Backend validation

The function rejects the write unless all of these are true:

- Caller is the hardcoded operations admin UID or is allowlisted under `admin_users/{uid}`.
- Tour exists, is active, and `tourCode` still maps to the selected `tourId`.
- Pickup date is a strict date and falls within the tour start/end dates.
- Booking reference is Firebase-key safe, is not a driver code, and does not already exist under `bookings`, `booking_identities`, or the tour manifest.
- A supplied email is normalized and valid. Blank email is allowed for a roster-only booking.
- Passenger names, phones, and seat numbers are present and valid.
- Seats are unique inside the submitted booking and not already assigned on the selected tour.

## Writes

After validation, the function writes one atomic multi-path update:

- `bookings/{bookingRef}` in the same effective shape produced by the sync parser:
  - `bookingRef`, `tourId`, `tourCode`
  - `passengerNames`, `passengers`, `passengerDetails`
  - `pickupPoints`, `pickupDate`, `pickupTime`, `pickupLocation`
  - `seatNumbers`, `seatLabels`
- `booking_identities/{bookingRef}` with normalized login email fields only when a valid email is supplied.
- `bookings/{bookingRef}/loginEligible` set to `true` when that identity is created, or `false` for a roster-only entry.
- `tour_manifests/{tourId}/bookings/{bookingRef}` initialized to `PENDING` for all passengers.
- `tours/{tourId}/pickupPoints` merged with the submitted pickup point.
- `pickupPoints/{tourId}` merged with the submitted pickup point.
- Capacity uses the maximum of valid imported counters, active source booking rows, the runtime counter, and active source count plus existing manual roster rows. Manual rows are counted once; `sold`, `bookedPassengerCount`, `manifestPassengerCount`, and runtime-owned `currentParticipants` are not rewritten by this endpoint.
- `tours/{tourId}/manualPassengerCount` records the exact manual overlay count in the same atomic update. Dashboard/admin booked totals combine the largest valid source counter with this separate scalar. Source/runtime counters keep their original ownership.

The function does not write `users/{uid}` or `tours/{tourId}/participants/{uid}`. The verified server login/join flow owns those identity and membership records. A roster-only booking has no `booking_identities/{bookingRef}` record and cannot sign in; the server does not invent an email or credentials.

## Concurrency

Manual creation uses short-lived server-side locks under `manual_booking_creation_locks` for the booking reference and selected tour. This serializes manual additions enough to prevent duplicate booking references and seat collisions through this endpoint.
It also acquires the same five-minute `sync_roster_control/{tourId}` lease used by the importer before reading canonical capacity and seats, and renews it before the atomic write. Owner-only release preserves source publication cursors. Failed imports still marked updating reject creation even after their lease expires. Superseded source rows neither occupy capacity nor reserve their former seats.
Rejected transaction callbacks return unchanged current data so Firebase's server CAS can refresh stale SDK cache values; an immediate local abort would falsely reject a released lease. Final owner and expiry checks remain authoritative. The HTTP response waits for cleanup, preserving a successful creation outcome if cleanup only logs a warning. Actual independent-connection and sequential HTTP tests cover this boundary.
The importer recomputes the manual scalar and merges current manual booking pickups into both aggregate pickup projections. It removes obsolete source pickup entries, preserves manual stops and does not include operator overlays in the source generation hash.

## Release order

Deploy `createManualPassengerBooking` before publishing the web-admin bundle that exposes the Add Passenger UI. The web-admin client derives the endpoint from `VITE_FIREBASE_PROJECT_ID` unless `VITE_CREATE_MANUAL_PASSENGER_URL` is set explicitly.
