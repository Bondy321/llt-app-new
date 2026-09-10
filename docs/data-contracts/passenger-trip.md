# Live passenger trip

The enabled passenger flow has one AppShell-owned controller. It supplies mutable
booking, tour summary and published customer itinerary to Home/agenda, itinerary,
native/web map and contact surfaces. Authentication identity, queue ownership and
photo/chat principals remain the established session objects.

## Authority and wire contract

`getPassengerTripSnapshot` is a read-only POST in europe-west1. It uses existing
bearer and App Check policy, checks the exact active passenger session twice, and
derives the booking from the server-owned profile. It verifies the private device
binding/principal, participant session, canonical booking/tour association and
account-deletion barriers. The body cannot select a booking, tour or database path.

Browser access is an exact-origin allowlist. Set `PASSENGER_APP_ALLOWED_ORIGINS`
to the comma-separated production and staging web origins before deploying the
Function. Local development permits `localhost` and `127.0.0.1`; origin-absent
native requests remain compatible. The Firebase `onRequest` wrapper completes an
allowed preflight before bearer/session/App Check verification and adds the origin
grant to both successful and structured error responses. A denied origin receives
no CORS grant, and an actual request from it is rejected before authentication.

The generated v1 contracts are `PassengerTripScope`, `PassengerTripSnapshot`,
`PassengerTripPart` and `PassengerTripCache`. Request: `expectedSessionId`, a
nonempty subset of `booking`, `tour`, `itinerary`, and optional `versions`.
Response: schemaVersion, exact trusted scope (authUid, principalId, bookingRef,
tourId, sessionId), checkedAtMs, requested parts. Each part is `value` with a
recursively allowlisted value, `unchanged`, `absent` (itinerary withdrawal), or
`unavailable`. SHA-256 versions are content equality tokens; they exclude check
time. Conditional responses still authorise and read sources. HTTP caching is
private/no-store. Retryable failures retain previous values and check times.

Booking content comes from one exact canonical booking and existing passenger/seat
normalisation. Public summary reads explicit leaves; assignment revision brackets
the reads with a bounded retry. Invalid date pairs or unstable assignment are
unavailable. Counts are included only when supplied. Itinerary is only the
published customer document. Operational services, supplier/commercial fields,
driver itinerary, other bookings and participant records never enter display/cache.

## Signals and lifecycle

Two subscriptions per active foreground passenger scope:

- `passenger_trip_signals/v1/bookings/{bookingRef}`: schemaVersion and booking counter.
- `passenger_trip_signals/v1/tours/{tourId}`: schemaVersion, tour and itinerary counters.

Exact-booking and explicit public tour-leaf/customer-itinerary write triggers cover
parent replacements and Admin SDK/import writes. Atomic counters carry no customer
content. No GPS, chat, service or participant trigger is added. Booking/tour deletion
removes associated signals. Missing signals need no backfill: start, reconnect,
foreground and manual checks read canonical data. Changed/disappeared signals only
mark their respective parts dirty. A 40 ms burst window coalesces work; one active
request and one accumulated follow-up preserve changes arriving during a request.
An initial signal delivered before its part's first read is covered by that read;
a first delivery during or after the read triggers bounded revalidation, since it
may represent a newer source generation. Cached essentials never await signal
initialisation.
Transient request failures and HTTP-200 `unavailable` parts have three exponential
retries (1/2/4 seconds) per part, paused offline/background and cancelled on cleanup.
Only failed parts retry; successful unrelated parts do not reset their budgets or
check timestamps. Success clears that part's retry budget; explicit manual and
lifecycle checks can start a fresh budget. Withdrawal/absence does not retry.
Manual refresh settles independently
of outgoing queues and optional manifest/location reads.

Login projections are a nonblocking unverified seed because the legacy login
contract lacks per-part check metadata. This intentionally performs one background
validation, not another login or a second blocking fetch. Every requested part has
its own freshness and durable-save status. Clock ticks/foreground update day context
without network polling. Driver/disabled itinerary keeps its existing editing path.

## Cache, migration and cleanup

One AsyncStorage value at an encoded exact owner/session key under
`@LLT:passengerTrip:v1:` commits content, versions and check times together. No email
or identity credential is added. Serial writes recheck controller lifetime inside
the lock. Cleanup stops the controller synchronously before other awaited work,
drains prior cache writes and deletes the exact envelope. Delayed reads, hydration,
signals and retries cannot recreate it. Authentication expiry and pending logout/
deletion recovery retain their existing owners.

Legacy session keys and pack remain authentication/compatibility seeds. Enabled
navigation writes only its route and identity binding; content refresh never writes
those keys or pack timestamps. Offline login no longer stamps a new pack sync time.
On first exact-owner use, legacy itineraries are narrowed; comparable revisions
select the later published content. Otherwise the safe nested view stays unverified
until an online check. Unknown/cross-principal caches are rejected. A committed new
envelope takes precedence. Driver caches are unchanged.

## Additive release and rollback

1. Deploy the endpoint and all passenger-trip source triggers, preserving older Functions.
2. Deploy exact-read signal rules; verify successful own-scope reads as well as denials.
3. Enable `EXPO_PUBLIC_PASSENGER_TRIP_ENABLED=true` in a staging client build; default
   and any other value are disabled. Exercise the entire enabled acceptance story.
4. Release the verified client through the existing release process.

There is no production flag mutation or global migration/backfill in this work.
The existing notification-retention protocol hashes the complete rules artifact.
Its two declared digests have been updated for the additive signal rules; this
also changes the immutable retention protocol ID. A release owner must coordinate
retention's existing paused rollout and fresh deployment-attestation/evidence
procedure for these exact artifacts. Old retention evidence must not be reused,
and deploying only rules without coordinating retention can pause that compactor.
No retention rollout, scheduler, evidence or production heartbeat was changed here.
Endpoint/rule unavailability leaves safe seed/saved details with truthful failed
check state; it never falls back to raw records. Rollback disables the client gate
and restores the existing passenger itinerary pipeline. Legacy authentication seed
data remains compatible but can be older; reconnect/sign in during rollback when
current detail is required. Signals/endpoints are additive and may remain deployed.
Remove the temporary legacy seed reader only after supported caches have migrated.

## Remaining staging/device smoke

- Log in as a synthetic passenger, change pickup and seat through a real supported
  operations/import writer, and observe Home/map without another login.
- Reassign driver; verify Home, map and Safety Support calls use the new number,
  then remove contact and confirm the old action disappears.
- Publish a revised itinerary. Check home agenda; close without opening itinerary,
  reopen offline within the authorised window, then open the saved full itinerary.
- Withdraw publication and confirm no old content returns after offline restart.
- Delay/fail boarding and GPS; check essentials, independent refresh settlement,
  large text and screen-reader wording. Verify date rollover/foreground day selection.
- Logout/delete while a refresh/cache write is pending; reopen and confirm isolation.
- In the enabled deployed web build, verify browser preflight, authorised snapshot
  and structured session-error access from each configured passenger web origin.

Automated integration invokes real domain/trigger handlers against synthetic DB
state and renders React Native components with native hosts mocked. It verifies the
real active-session/profile/booking boundaries; only outer bearer/App Check token
verification is injected. It is not a deployed-trigger or physical-device test.
The cross-stack integration test runs exactly once in `test:functions:scripts`,
whose CI job installs root and Functions dependencies. Ordinary mobile aggregates
require only the root dependency installation.
The corrective local browser smoke used the real Firebase wrapper and real
session/source checks against synthetic data, injecting only outer token
verification. Browser-enforced cross-origin fetch returned the successful snapshot
and a readable SESSION_CHANGED error: one preflight, two POSTs, two authorisations.
This does not replace the deployed-origin or physical-device smoke above.
