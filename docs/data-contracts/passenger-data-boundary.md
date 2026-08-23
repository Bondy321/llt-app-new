# Passenger data boundary

Passenger login is a server projection boundary, not permission to download an operational tour or booking record.

`verifyPassengerLogin` validates the booking reference/email and returns two recursively allowlisted objects:

- `booking`: booking/tour identity, passenger names, seats, the passenger's pickup date/time/location/address, and party size;
- `tour`: public tour identity/dates/destination/capacity, driver contact, and the customer itinerary.

It must never return services, contracts, commercial fields, driver itinerary, supplier data, internal notes, other participant records, email, or passenger telephone data. The mobile client validates the same allowlist before using the response.

Realtime Database rules deny passenger reads of whole `bookings/{bookingRef}` and `tours/{tourId}` records. Passenger access is limited to purpose-specific children such as the customer itinerary, driver location, the caller's participant/live-tracking row, and the caller's exact manifest booking. Assigned drivers and operations retain their operational access.

Passenger session and Tour Pack restores pass through the allowlist. A valid legacy cache is atomically replaced with the narrowed object before login succeeds; a cache that cannot be projected requires an online refresh. Driver caches are not transformed by this migration.

Backend access changes ship in this order: Function projection, Realtime Database rules, then the mobile OTA/build.
