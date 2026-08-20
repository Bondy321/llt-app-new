# Driver Tour Pack ingestion contract (Gate 5)

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
driver_tour_pack_tombstones/{departureKey}
driver_tour_pack_ingestion/activeRun
driver_tour_pack_ingestion/runs/{runId}
driver_tour_pack_ingestion/staging/{runId}
driver_tour_pack_ingestion/packMetadata/{departureKey}
driver_tour_pack_ingestion/latestSuccessfulRun
```

`departureKey` is `YYYY-MM-DD::NORMALIZED_TOUR_ID`. Gate 5 rules explicitly deny every client read and write to these roots, including operations admins. Admin SDK writes from the Function bypass rules. Gate 6 will add exact assigned-driver reads to the pack root only; ingestion and tombstone audit roots stay server-private.

The publisher module asserts that its final multi-location update contains only the three root families above. It has no code path for `tours`, `bookings`, `booking_identities`, `tour_manifests`, driver actions, chat or photos.

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

## Schema and limits

The current schema is version 1. The schema module exports the readable-version allowlist; this first release has no predecessor. When version 2 is introduced, version 1 must remain in that allowlist and be covered by reader tests throughout rollout.

Important limits include 1,000 packs/run, 40 batches/run, 25 packs/batch, 100 passengers/pack, 120 seats/pack, 150 services/pack and 24,000 characters per itinerary. Unknown fields, excessive strings/collections, non-Firebase-safe keys, invalid dates/statuses/revisions, email values, commercial field names and stale fingerprints fail closed.

## Deployment and IAM verification

Deploy Functions before any Gate 6 read rules:

```powershell
$env:FUNCTIONS_DISCOVERY_TIMEOUT='60'
npx firebase-tools deploy --only functions:ingestDriverTourPacks --project loch-lomond-travel
```

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
