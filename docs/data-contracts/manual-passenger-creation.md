# Manual Passenger Creation Contract

Web admin can add a booking manually through the `createManualPassengerBooking` Cloud Function.

## Purpose

This path is for rare operations/admin use, including creating a test passenger account for app review. It must produce a booking that behaves like a normal sync-uploaded booking in the passenger app.

## Required input

- Existing active `tourId` selected from web admin.
- Unique booking reference.
- Login email address.
- Pickup date, time, and location.
- One or more passenger rows, each with full name, seat number, and phone number.

## Backend validation

The function rejects the write unless all of these are true:

- Caller is the hardcoded operations admin UID or is allowlisted under `admin_users/{uid}`.
- Tour exists, is active, and `tourCode` still maps to the selected `tourId`.
- Pickup date is a strict date and falls within the tour start/end dates.
- Booking reference is Firebase-key safe, is not a driver code, and does not already exist under `bookings`, `booking_identities`, or the tour manifest.
- Email is normalized and non-empty.
- Passenger names, phones, and seat numbers are present and valid.
- Seats are unique inside the submitted booking and not already assigned on the selected tour.

## Writes

After validation, the function writes one atomic multi-path update:

- `bookings/{bookingRef}` in the same effective shape produced by the sync parser:
  - `bookingRef`, `tourId`, `tourCode`
  - `passengerNames`, `passengers`, `passengerDetails`
  - `pickupPoints`, `pickupDate`, `pickupTime`, `pickupLocation`
  - `seatNumbers`, `seatLabels`
- `booking_identities/{bookingRef}` with normalized login email fields.
- `tour_manifests/{tourId}/bookings/{bookingRef}` initialized to `PENDING` for all passengers.
- `tours/{tourId}/pickupPoints` merged with the submitted pickup point.
- `pickupPoints/{tourId}` merged with the submitted pickup point.
- `tours/{tourId}/bookedPassengerCount` and `tours/{tourId}/manifestPassengerCount` recalculated from existing tour bookings plus the new booking.

The function does not write `users/{uid}` or `tours/{tourId}/participants/{uid}`. The passenger app writes those when the passenger signs in and joins the tour through the normal verified-login path.

## Concurrency

Manual creation uses short-lived server-side locks under `manual_booking_creation_locks` for the booking reference and selected tour. This serializes manual additions enough to prevent duplicate booking references and seat collisions through this endpoint.

## Release order

Deploy `createManualPassengerBooking` before publishing the web-admin bundle that exposes the Add Passenger UI. The web-admin client derives the endpoint from `VITE_FIREBASE_PROJECT_ID` unless `VITE_CREATE_MANUAL_PASSENGER_URL` is set explicitly.
