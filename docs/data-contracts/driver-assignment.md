# Driver Assignment Data Contract

Use this contract for all driver-to-tour assignment writes (mobile + web-admin).

## Canonical nodes involved

- `drivers/{driverId}`
- `tour_manifests/{tourId}/assigned_drivers/{driverId}`
- `tour_manifests/{tourId}/assigned_driver_codes/{driverId}`
- `users/{authUid}/driverId`
- `users/{authUid}/driverPrincipalId`
- `users/{authUid}/driverAssignedTourId`
- `users/{authUid}/principalType`

Assignments must be written as one multi-path update to keep these nodes consistent.

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

## Producers

- Mobile: `services/bookingServiceRealtime.js` (`assignDriverToTour`)
- Web admin: `web-admin/src/services/tourService.js` (`buildDriverAssignmentUpdates`)

Both producers must emit identical field names and casing.

## Driver manifest authorization

Drivers update passenger manifest rows through:

`tour_manifests/{tourId}/bookings/{bookingRef}`

Security rules authorize that write when all of the following are true:

1. `users/{authUid}/driverId` points to the driver code.
2. `drivers/{driverId}/authUid` matches the caller auth UID.
3. `tour_manifests/{tourId}/assigned_drivers/{driverId}` is `true`.
4. The booking belongs to `{tourId}` by canonical `bookings/{bookingRef}/tourId`.

Mobile driver login and driver assignment writes must therefore persist the driver profile helper fields above. Web-admin assignment writes should also persist them when the driver profile already has an `authUid`.
