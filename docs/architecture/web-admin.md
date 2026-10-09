# Web administration architecture

Broadcast creation uses a server-authoritative audience preview and retains deliberate confirmation.
Delivery reporting distinguishes fan-out, Expo ticket and Expo receipt state; it never exposes raw
push tokens or describes ticket acceptance as delivery. Requeue and full-pipeline test actions use
authenticated operations-admin Functions endpoints.

The admin shell authenticates and authorizes operations users, then lazy-loads Dashboard, Drivers, Tours, Broadcast, Moderation, and Settings routes. The loading state is accessible and feature chunks do not enter the initial route bundle.

Large sections are split into feature presentation and data modules while their historic `src/components/*` entrypoints remain compatible. Dashboard and Tours use bounded views/components; tour CRUD, content mutation, CSV import, assignment, and context are separate data responsibilities. Drivers and broadcasts expose focused feature components/domain helpers.

Presentation must not issue raw Firebase operations. Reads, subscriptions, and mutations go through the existing service/repository boundary, preserving authorization checks, confirmations, Mantine controls, URL filters, and data shapes.

Driver assignment and unassignment call the authenticated `assignDriverToTour`
backend used by mobile. The browser sends the observed driver and tour revisions
plus a bounded idempotency key; it never constructs the canonical driver/tour/
manifest/user write. The UI distinguishes stale revision, already-changed,
in-progress, and policy-transition responses and keeps progress/error feedback in
accessible live regions.

Driver device-policy changes expose their durable draining/cleanup progress. The
destructive enable action remains confirmed; disabling is non-destructive for
valid current sessions. `DRIVER_POLICY_CHANGE_IN_PROGRESS` is presented as a
temporary settings transition, never as abuse or too-many-attempts wording.

To add an admin section, create a feature folder, expose a stable route component, add a `React.lazy` route in `App.jsx`, provide an accessible loading state, keep Firebase calls in a repository/service, and add visible behavior tests plus a production-build chunk check.

Track Coaches has one Leaflet renderer per mounted map view, with URL-backed
filters, selection, map/list choice and pickup visibility. The renderer owns map
lifecycle and tile failures; the repository owns four bounded subscriptions and
automatically expands the listed-row query with a sentinel, independently of the
500-tour dashboard window. Presentation ages points every fifteen seconds using
the server clock offset, clears invalid/expired positions, marks offline caches
and never sends names or GPS records to the tile provider. Numbered markers
group nearby tour positions; an accessible list provides the same selection.

Demo mode is an explicit, labelled presentation-only data source that closes the
real feed. Leaving it mounts a fresh real subscription and clears sample
selection/filters. It never writes to Firebase or restores sample data as live.
See [the tracking contract](../data-contracts/admin-coach-tracking.md).
