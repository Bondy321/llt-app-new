# Offline Tour Pack (Mobile)

## Scope

`services/offlineSyncService.js` manages local Tour Pack cache + offline action queue for passenger and driver flows.

## Architecture

```text
Screen actions
  -> offlineSyncService
      -> persistenceProvider (SecureStore -> AsyncStorage -> memory)
      -> Tour Pack cache (role + tour scoped)
      -> action queue (manifest/chat/internal-chat/photo)
  -> replay triggers (foreground, reconnect, manual refresh, login restore)
```

## Cache keys

- `tour_pack_passenger_<tourId>`
- `tour_pack_driver_<tourId>`
- `tour_pack_meta_passenger_<tourId>`
- `tour_pack_meta_driver_<tourId>`
- `queue_v1`
- `processed_action_ids_v1`

## Queue action types

- `MANIFEST_UPDATE`
- `CHAT_MESSAGE`
- `INTERNAL_CHAT_MESSAGE`
- `PHOTO_UPLOAD`

### PHOTO_UPLOAD payload contract (Phase 1)

`PHOTO_UPLOAD` is now the canonical durable photo-upload action and is used by both group and private photobook surfaces.

Required normalized fields:

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
- `localAssets.thumbnailUri`
- `localAssets.viewerUri`
- `localAssets.optimizationMetrics`

## Replay policy

1. FIFO execution by `createdAt`.
2. In-process single-run lock (no parallel replay).
3. Max retry attempts: 5 per action.
4. Processed action IDs persisted locally to avoid duplicate replay after restart.
5. Failed actions remain visible and retryable.
6. `PHOTO_UPLOAD` replay transitions are `queued|retrying -> uploading -> completed|failed`.
7. `PHOTO_UPLOAD` replays through `photoService.uploadPhotoDirect(...)` only (screen components never call upload network code directly).

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
