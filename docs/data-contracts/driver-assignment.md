# Driver Assignment Data Contract

Use this contract for all driver-to-tour assignment writes (Functions + web-admin).

## Canonical nodes involved

- `drivers/{driverId}`
- `tours/{tourId}/driverId`
- `tours/{tourId}/driverName`
- `tours/{tourId}/driverPhone`
- `tour_manifests/{tourId}/assigned_drivers/{driverId}`
- `tour_manifests/{tourId}/assigned_driver_codes/{driverId}`
- `users/{authUid}/driverId`
- `users/{authUid}/driverPrincipalId`
- `users/{authUid}/driverAssignedTourId`
- `users/{authUid}/principalType`

Assignments must be written as one multi-path update to keep these nodes consistent.

Each driver has at most one canonical active assignment, stored in `drivers/{driverId}/currentTourId`. Reassignment removes stale manifest and tour display links in the same update. The web admin UI must describe this as a single assignment, not as a multi-tour list.

## Canonical payload shape

```ts
interface AssignedDriverCodeRecord {
  driverId: string;    // canonical driver key, e.g. "D-BONDY"
  tourId: string;      // sanitized Firebase key, e.g. "5112D_8"
  tourCode: string;    // human-readable code, e.g. "5112D 8"
  assignedAt: string;  // ISO timestamp, e.g. "2026-02-01T10:15:00.000Z"
  assignedBy: string;  // actor key/uid
}
```

## Validation requirements

- `driverId`: required, must match the `{driverId}` path segment.
- `tourId`: required, sanitized Firebase-safe key.
- `tourCode`: required non-empty display code.
- `assignedAt`: required ISO datetime with timezone.
- `assignedBy`: required non-empty actor identifier.

## Producers and authority

- Mobile calls the authenticated `assignDriverToTour` HTTPS Function through
  `services/bookingServiceRealtime.js`; it does not write assignment paths directly.
- The Function validates that `drivers/{driverId}/authUid` is the caller, rejects an
  inactive or already-occupied tour, serializes competing assignments with short-lived
  driver/tour locks, and applies the canonical multi-path update with the Admin SDK.
- Web admin uses `web-admin/src/services/tourService.js`
  (`buildDriverAssignmentUpdates`) under an operations-admin identity.

Both server and web-admin producers must emit identical field names and casing.

## Driver manifest authorization

Drivers update passenger manifest rows through:

`tour_manifests/{tourId}/bookings/{bookingRef}`

Security rules authorize that write when all of the following are true:

1. `users/{authUid}/driverId` points to the driver code.
2. `drivers/{driverId}/authUid` matches the caller auth UID.
3. `tour_manifests/{tourId}/assigned_drivers/{driverId}` is `true`.
4. The booking belongs to `{tourId}` by canonical `bookings/{bookingRef}/tourId`.

`verifyDriverLogin` transactionally claims an unclaimed driver code for the authenticated
Firebase UID and persists the driver profile helper fields. Clients cannot claim a driver,
change assignment authority fields, or add their own manifest assignment. A claimed driver
may update only its activity timestamp and may remove its own `authUid` as part of account
deletion. Web-admin assignment writes should also persist the profile helper fields when the
driver profile already has an `authUid`.
