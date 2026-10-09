# Admin Coach Tracking Projection

Updated: 9 October 2026

The Track Coaches map reads the server-owned compact projection at
`admin_dashboard/v1/coach_tracking/{tourId}`. It does not read tour manifests,
passenger records, driver contact records, or private location session roots.

```ts
{
  schemaVersion: 1,
  listed: true,
  tourId: string,
  tourCode: string,
  name: string,
  startAtMs: number | null,
  endAtMs: number | null,
  isActive: boolean,
  assignedDrivers: Array<{ driverId: string, name: string }>,
  assignmentOverflow: boolean,
  location: SafePublicDriverLocation | null,
  updatedAtMs: number,
  projectionRevision: number,
  sourceFingerprint: string
}
```

`assignedDrivers` is derived from `drivers.currentTourId === tourId`, queried by
the indexed current-tour field and capped at 100 plus one sentinel. The row
contains at most 100 drivers. `assignmentOverflow: true` means more assignments
exist than are shown; consumers must not describe the list as complete. The
identity of an assigned driver does not establish which driver or device
published GPS coordinates.

`location` is whitelisted from the public `tours/{tourId}/driverLocation`
projection. It contains only sharing state, mode/source, coordinates, timestamp,
accuracy, address, and a similarly filtered `fallbackPickup`. Private session,
auth, phone, passenger, and booking fields are never copied. A withdrawn or
invalid location becomes `null`; legacy records without `isSharing` are accepted
only when coordinates and a positive timestamp validate. Removed tours are
retained as `listed:false, deleted:true` tombstones so clients can query indexed
active rows without unboundedly accumulating deleted keys.

The sibling `admin_dashboard/v1/coach_tracking_status` is server-owned and
admin-readable. Its `state` is `building`, `ready`, or `error`; `ready` is written
only when bounded driver, location, and existing-row scans finish and candidate
reconciliation completes. A missing status record
means backfill has not prepared the feed. The UI should show that state rather
than interpreting an empty row list as an empty fleet. Rows are enumerated with
bounded key pages; the client must report when its own display cap leaves more
rows to load.

Functions reconcile one tour at a time using a per-tour generation reservation
and fresh reads of
tour scalar fields, public location, and indexed current assignments. Triggers
cover relevant scalar/location writes, current-tour changes (including removal
of an assigned driver), and driver-name changes without subscribing to broad
tour or driver objects. The repeatable
backfill scans current-tour drivers and indexed sharing locations in bounded
pages, then rereads each candidate before applying its row.

The backfill uses bounded indexed server-side scans. The Realtime Database
query API returns full matching tour records for the location timestamp index;
the trusted migration process immediately reduces each page to tour IDs and
never logs or persists those query payloads. Browser clients never read this
source tree. Driver assignment scans use the indexed `currentTourId` field and
existing projection scans use indexed `listed` rows. Reconciliation then reads
only whitelisted tour scalar/location paths and exact current driver records.

Deploy the Functions and Realtime Database rules before running the backfill.
From the repository root, deploy rules with
`firebase deploy --only database`, then deploy the eight new Functions by name.
From the `functions` directory, first run `npm run backfill:coach-tracking`
(dry-run by default), inspect candidate counts, then explicitly apply with
`npm run backfill:coach-tracking -- --apply --confirm-project=loch-lomond-travel`.
Apply mode checks both the project ID and the exact
`https://loch-lomond-travel-default-rtdb.europe-west1.firebasedatabase.app`
instance, and rejects the Firebase Database emulator. The backfill is safe to
rerun; a partial run leaves status as
`building` or `error`, never `ready`.

Deploy the Functions with the exact exported names:

```sh
firebase deploy --only functions:projectCoachTrackingDriverCurrentTour,functions:projectCoachTrackingDriverName,functions:projectCoachTrackingLocation,functions:projectCoachTrackingTourActive,functions:projectCoachTrackingTourCode,functions:projectCoachTrackingTourEndIndex,functions:projectCoachTrackingTourName,functions:projectCoachTrackingTourStartIndex
```

For initial creation, the pinned Firebase CLI requires `--force` to acknowledge
the deliberately retryable policy. Keep the eight-function filter exact; do not
use an unfiltered forced deployment. Source rereads and generation fences make
retries safe. Before running the local backfill, provide public target config in
`FIREBASE_CONFIG` with `projectId: loch-lomond-travel` and database URL
`https://loch-lomond-travel-default-rtdb.europe-west1.firebasedatabase.app`;
use an existing authorised Application Default Credential. The apply guard
checks the actual project and database URL and rejects emulator targets.

## Verified deployment

On 9 October 2026, the exact rules and eight Node 22 / Gen 2 projection exports
were deployed in europe-west1, followed by a complete six-candidate backfill and
the admin Hosting release. Real authentication, the complete six-tour feed,
expired-position exclusion, demo separation and map rendering were checked live.
A temporary inactive source tour proved deployed publication and withdrawal;
its source was removed and its derived row became an unlisted, coordinate-free
tombstone. No real booking or driver assignment was changed. Notification
retention remained paused at revision 8; its new rules protocol requires the
existing attestation procedure before any future activation.

Board presentation: open `/track-coaches?demo=1` in the authenticated admin.
The demo uses example positions and has a Restart demo action. Real tracking
selects one position per tour, and reliable locked-phone acceptance still needs
the matching native 1.0.7 apps and physical devices.
