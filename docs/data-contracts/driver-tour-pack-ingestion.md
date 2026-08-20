# Driver Tour Pack ingestion, access, expiry and mobile reader contract (Gates 5-7)

`ingestDriverTourPacks` is the only cross-project write boundary for management-generated Driver Tour Packs. It is a Gen 2 HTTP Function in `europe-west1` and is not a browser API.

## Authentication and network contract

The Function has two independent caller checks:

1. deployed `invoker` IAM is restricted to `llt-dashboard-sync-runner@llt-management-dashboard.iam.gserviceaccount.com`;
2. application code verifies the Google OIDC ID token against the exact Function audience and requires that same verified service-account email.

It accepts only `POST` with JSON. Requests with a browser `Origin`, non-JSON content, missing/invalid OIDC, or an oversized body are rejected. CORS is disabled. Logs contain only action, run ID, counts, hashes, status and safe reason codes.

The canonical audience is:

```text
https://europe-west1-loch-lomond-travel.cloudfunctions.net/ingestDriverTourPacks
```

Optional server-only environment overrides are `DRIVER_TOUR_PACK_AUDIENCE` and `DRIVER_TOUR_PACK_CALLER_SERVICE_ACCOUNT`. They must never broaden the caller set.

## Roots

```text
driver_tour_packs/{departureKey}
driver_tour_pack_actions/{departureKey}/{driverId}
driver_tour_pack_tombstones/{departureKey}
driver_tour_pack_ingestion/activeRun
driver_tour_pack_ingestion/runs/{runId}
driver_tour_pack_ingestion/staging/{runId}
driver_tour_pack_ingestion/packMetadata/{departureKey}
driver_tour_pack_ingestion/latestSuccessfulRun
```

`departureKey` is `YYYY-MM-DD::NORMALIZED_TOUR_ID`. Gate 5 rules denied every client read and write. Gate 6 permits a read of exactly one `driver_tour_packs/{departureKey}` leaf only when all three independent records agree:

1. `users/{authUid}/driverId` exists;
2. `drivers/{driverId}/authUid === authUid`;
3. `tour_manifests/{pack.tourId}/assigned_drivers/{driverId} === true`.

The collection root remains unreadable, so RTDB queries/listing cannot discover another departure. Passengers, anonymous callers, stale or forged driver profiles, and cross-tour reads are denied. Client writes to source packs always remain denied. Ingestion and tombstone audit roots remain server-private, including to operations admins.

Rules also require `expiresAtMs > now` for source-pack reads and action writes. Access therefore revokes immediately at expiry even before the scheduled physical cleanup catches the next bounded batch.

`driver_tour_pack_actions` is deliberately separate from the publisher roots. An assigned driver may read/write only their own exact action leaf under a readable assigned pack. Gate 6 exposes only acknowledgement plus pickup/service progress leaves; pickup and service keys must already exist in the bounded source pack, so they cannot be expanded beyond projection limits. All writes are leaf-only so RTDB can deny every unknown path; callers must not replace an action object. Invalid enum values and timestamps more than five minutes in the future are denied. Structured issue reports remain server-closed until Gate 10 defines their final workflow and notification contract. Actions cannot be written beneath a different driver ID.

The publisher module asserts that its final multi-location update contains only the three root families above. It has no code path for `tours`, `bookings`, `booking_identities`, `tour_manifests`, driver actions, chat or photos.

## Retention and expiry cleanup

`expiresAtMs` is the authoritative retention deadline. `cleanupExpiredDriverTourPacks` is a Gen 2 scheduled Function in `europe-west1`, every six hours. It uses the server-only `expiresAtMs` index and handles no more than 50 expired packs per invocation. For each eligible pack it atomically removes the full pack, all driver action state, and the publisher metadata index, then writes a PII-free `RETENTION_EXPIRED` tombstone containing only departure identity, revision and timing.

The operation is retry-safe: after the pack node is gone it cannot be selected again. Removing metadata means an otherwise-identical future republish is treated as a fresh source pack rather than an unsafe no-op. The cleanup never accesses bookings, manifests, passengers or identity roots.

## Protocol

### Begin

The caller sends run identity, source snapshot, start time, batch count, a PII-free descriptor for every departure, and a deterministic aggregate SHA-256 fingerprint. The Function:

- rejects stale runs and conflicting reuse of a run ID;
- obtains a single active-run lease;
- compares descriptors with its PII-free pack metadata index;
- returns the authoritative `revision`, `publishedAtMs` and action (`create`, `update`, `noop`, `tombstone`) for each pack;
- stores only descriptors, plans, counts and hashes in the run audit.

### Upload

Each batch contains at most 25 packs and the whole request is at most 2 MB. Every pack is recursively schema-validated and privacy-validated before any pack in the batch is staged. The Function recomputes the content fingerprint, checks the server revision plan, and transactionally claims departure keys so they cannot appear in different batches.

An identical retry is idempotent. A different replay for the same run, batch or departure is rejected.

### Finalize

Finalize requires every declared batch. The Function reloads and revalidates every staged pack, pack count, batch hash, inventory key and aggregate hash. Only then does one RTDB multi-location update:

- create/update changed packs;
- preserve unchanged packs without rewriting them;
- replace cancelled/withdrawn packs with PII-free tombstones;
- update the metadata index and run audit;
- move `latestSuccessfulRun`;
- remove staging and release the lease.

A partial, malformed, stale or conflicting run cannot move the pointer. Omitting a departure from a later run does not delete it. Deletion requires an explicit tombstone or lifecycle cleanup.

Cancellation/withdrawal source records retain only departure identity, safe status/version/timing/quality metadata and empty structural shells. Passenger, pickup, seat, hotel, service, coach-detail, contact, itinerary and tour-description content must all be empty; both server and mobile validators reject a tombstone that retains operational text.

## Schema and limits

The current schema is version 1. The schema module exports the readable-version allowlist; this first release has no predecessor. When version 2 is introduced, version 1 must remain in that allowlist and be covered by reader tests throughout rollout.

Important limits include 1,000 packs/run, 40 batches/run, 25 packs/batch, 100 passengers/pack, 120 seats/pack, 150 services/pack and 24,000 characters per itinerary. Unknown fields, excessive strings/collections, non-Firebase-safe keys, invalid dates/statuses/revisions, email values, commercial field names and stale fingerprints fail closed.

## Gate 7 mobile reader and cache

The mobile schema in `services/driverTourPackSchema.js` mirrors the server's versioned recursive allowlist and relationship checks. `services/driverTourPackService.js` reads only an exact canonical departure key, scopes durable data by auth UID + driver ID + departure key, and atomically replaces a cache only after full validation. `hooks/useDriverTourPack.js` presents a valid cache first, listens only to exact revision metadata, fetches full content only for a semantic revision change, and ignores late work from an old assignment.

The mobile state model distinguishes missing, failed, stale, incomplete, expired and withdrawn. Network or validation failure preserves a valid cache. Expiry or withdrawal removes cached PII immediately. The app also validates the authoritative assignment leaf while a driver session is active; logout, identity change, reassignment and validation failure purge only the old driver's exact pack, complete manifest and queued operational scope.

The boarding manifest is independent. `getTourManifest` marks a complete v1 snapshot explicitly, and `driverManifestCacheService` rejects partial, empty, wrong-tour and malformed replacements. Offline queued boarding updates patch the scoped device snapshot after durable enqueue, while `tour_manifests` remains the sole server authority.

## Deployment and IAM verification

Deploy Functions before any Gate 6 read rules:

```powershell
$env:FUNCTIONS_DISCOVERY_TIMEOUT='60'
npx firebase-tools deploy --only functions:ingestDriverTourPacks,functions:cleanupExpiredDriverTourPacks --project loch-lomond-travel
```

Then deploy Realtime Database rules, then publish the mobile reader/cache update. Do not release a client that reads packs before the Functions and rules are present.

Verify the runtime service account has only invocation access in the app project and no broad database/project role:

```powershell
gcloud run services get-iam-policy ingestdrivertourpacks `
  --region europe-west1 `
  --project loch-lomond-travel

gcloud projects get-iam-policy loch-lomond-travel `
  --flatten="bindings[].members" `
  --filter="bindings.members:llt-dashboard-sync-runner@llt-management-dashboard.iam.gserviceaccount.com" `
  --format="table(bindings.role,bindings.members)"
```

Expected: the service-level invoker role only. It must not have Owner, Editor, Firebase Admin, Firebase Realtime Database Admin, Datastore owner, or a service-account key in this repository.
