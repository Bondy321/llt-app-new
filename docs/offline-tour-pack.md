# Offline Tour Pack (Mobile)

## Scope

The mobile app has three deliberately separate durable stores:

- `services/offlineSyncService.js` owns the existing passenger/driver screen cache and offline action queue;
- `services/driverTourPackService.js` owns the server-projected Driver Tour Pack cache;
- `services/driverManifestCacheService.js` owns the complete boarding-manifest snapshot.

They share an identity boundary but do not merge facts. Report facts never become boarding state, and queued boarding changes never modify the source Driver Tour Pack.

## Architecture

```text
Screen actions
  -> offlineSyncService
      -> persistenceProvider (durable AsyncStorage; legacy SecureStore migration; memory in tests only)
      -> Tour Pack cache (role + tour + login identity scoped)
      -> action queue (manifest/chat/internal-chat/photo, principal owned)
  -> replay triggers (foreground, reconnect, manual refresh, login restore)

Driver Tour Pack reader
  -> exact assigned departure revision listener
  -> strict full-pack validator
  -> identity-scoped atomic replacement cache

Passenger manifest
  -> getTourManifest (schemaVersion=1, complete=true)
  -> identity-scoped complete snapshot cache
  -> tour_manifests remains authoritative for updates
```

## Cache keys

- `tour_pack_v2_<role>_<tourId>_<encodedBookingOrDriverId>`
- `tour_pack_meta_v2_<role>_<tourId>_<encodedBookingOrDriverId>`
- `queue_v1`
- `processed_action_ids_v1`
- `LLT_DRIVER_TOUR_PACK` entries scoped by auth UID + driver ID + departure key
- `LLT_DRIVER_MANIFEST` entries scoped by driver ID + tour ID

The unversioned Tour Pack keys are cleanup-only legacy data. Every read and
write must provide an owner identity, either explicitly or through the active
session scope. This is required because a Tour Pack contains booking/driver
identity data, not just shared itinerary content.

## Shared-device ownership

Every queue action stores a versioned `scope` containing canonical `tourId`,
`principalId`, and `role`. Replay, counts, retries, removal, mutation, and
subscriptions filter on the complete scope. A session change increments the
generation and stops an in-flight replay before its next action. Entries for a
different login remain durable and invisible.

All queue read-modify-write operations are serialized. Observer reads never
persist sanitation repairs, preventing a stale observer snapshot from
overwriting a concurrent enqueue. Explicitly scoped subscriptions retain the
scope captured when they subscribe.

The separate safety retry queue follows the same identity boundary and uses a
stable queue event ID for snapshot/reconcile replay. Network writes do not hold
the storage lock, so a newly raised safety report is never blocked behind an
older upload. Remote submission is one idempotent multi-path write covering the
private log, tour alert, and critical global alert; the local item is removed
only after that commit succeeds. Trusted contacts use principal-specific v2
storage keys.

Driver logout, driver identity change, reassignment, assignment validation failure, source-pack withdrawal, and source-pack expiry purge the exact old operational scope. Purge stops queue replay first, removes the complete manifest, both Tour Pack caches and metadata, and removes only that scope's queued operational actions. A reassignment generation guard prevents late network responses from restoring data for the old tour.

## Driver Tour Pack reader contract

- `departureKey` is always `YYYY-MM-DD::NORMALIZED_TOUR_ID`; ambiguous or date-less assignments fail closed.
- A valid cache is shown immediately. The app subscribes only to the exact assigned pack's revision and fetches the full pack only when the semantic revision changes.
- Remote and cached packs pass the same recursive schema/privacy/relationship validation before use.
- A malformed or failed remote response never erases a valid cache.
- `missing`, `failed`, `stale`, `incomplete`, `expired`, and `withdrawn` are distinct states.
- Expired and withdrawn packs delete cached PII immediately and retain only safe state metadata.
- Listener generations make late responses from an old assignment inert.

## Complete manifest cold-start contract

`getTourManifest` returns an explicit `schemaVersion: 1` and `complete: true`. Only such a non-empty, internally consistent response can atomically replace the driver manifest cache. Unknown fields are dropped by construction and stats are recomputed locally. A partial, empty, malformed, duplicate-booking, failed, or wrong-tour response cannot replace a valid snapshot.

The Passenger Manifest screen renders a valid snapshot before attempting the network, so an airplane-mode cold start can show the complete manifest. Offline boarding changes are patched into that snapshot only after the existing durable `MANIFEST_UPDATE` queue accepts them. Reconciliation and server writes still target `tour_manifests`; the cache is never a second authority.

## Queue action types

- `MANIFEST_UPDATE`
- `CHAT_MESSAGE`
- `INTERNAL_CHAT_MESSAGE`
- `PHOTO_UPLOAD`

### PHOTO_UPLOAD payload contract (Phase 2)

`PHOTO_UPLOAD` is now the canonical durable photo-upload action and is used by both group and private photobook surfaces.

Required normalized fields:

- `payloadVersion` (`2` for source-only uploads)
- `jobId` (stable queue item id)
- `idempotencyKey` (deterministic per logical upload; reused on retry)
- `createdAt`
- `tourId`
- `visibility` (`group` | `private`)
- `ownerId` / `userId` identity fields compatible with current rules
- `localAssets.sourceUri`
- `metadata.caption` (optional)
- `attemptCount`
- `lastError`

Optional retained fields:

- `localAssets.previewUri`
- `localAssets.optimizationMetrics`

## Replay policy

1. FIFO execution by `createdAt`.
2. In-process single-run lock (no parallel replay).
3. Max retry attempts: 5 per action.
4. Processed action IDs persisted locally to avoid duplicate replay after restart.
5. Failed actions remain visible and retryable.
6. `PHOTO_UPLOAD` replay transitions are `queued|retrying -> uploading -> completed|failed`.
7. `PHOTO_UPLOAD` replays through `photoService.uploadPhotoDirect(...)` only (screen components never call upload network code directly).
8. Completed `PHOTO_UPLOAD` items are pruned deterministically (24h TTL while retaining the most recent completed items), while `failed|retrying` items are retained for manual retry.

## Manifest conflict policy

- Compare queued `lastUpdated` against server `lastUpdated`.
- Newer server value wins and local action is reconciled.
- Missing/equal timestamps default to server-preferred reconciliation.
- User-facing note: `One update was reconciled with newer server data.`

## Canonical sync-state contract

All refresh surfaces should consume the same four states:

- `OFFLINE_NO_NETWORK`
- `ONLINE_BACKEND_DEGRADED`
- `ONLINE_BACKLOG_PENDING`
- `ONLINE_HEALTHY`

Each state should include normalized metadata:
`label`, `description`, `severity`, `icon`, `canRetry`, `showLastSync`.

## Manual refresh copy contract

Use one formatter output across screens:

`"{X} synced / {Y} pending / {Z} failed"`

Never build per-screen ad-hoc summary strings.

## QA checklist

1. Offline manifest update queues and then syncs on reconnect.
2. Offline chat send shows queued state and clears after replay.
3. Manual refresh reports canonical summary and state taxonomy.
4. Retry failed actions only retries failed subset.
5. Restart app mid-backlog and verify no duplicate replays.
6. Switch between two identities on one device and verify neither queue,
   Tour Pack, safety report, nor trusted contact crosses the session boundary.
7. Cache a complete driver manifest, force-close, enable airplane mode, and verify a cold start shows every cached booking.
8. Reassign a driver while the previous pack is open and verify the old listener, caches, and queued operational actions are removed without touching the new scope.
9. Expire and withdraw a pack and verify cached PII is removed immediately while boarding authority remains unchanged.
