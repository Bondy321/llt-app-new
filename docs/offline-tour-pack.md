# Offline Tour Pack

## Architecture (text diagram)

```
Tour/Driver screens
  -> offlineSyncService
      -> persistenceProvider (SecureStore -> AsyncStorage -> memory)
      -> tour pack cache (per role + tour)
      -> queue (MANIFEST_UPDATE, CHAT_MESSAGE, INTERNAL_CHAT_MESSAGE)
  -> replay triggers (foreground, reconnect, manual sync, login restore)
  -> realtime database write-through when online
```

## Cache keys

- `tour_pack_passenger_<tourId>`
- `tour_pack_driver_<tourId>`
- `tour_pack_meta_passenger_<tourId>`
- `tour_pack_meta_driver_<tourId>`
- `queue_v1`
- `processed_action_ids_v1`

## Replay lifecycle

1. Action is enqueued with idempotency key.
2. Queue subscribers update UI badges (`queued`, `syncing`, `failed`).
3. Replay starts with in-memory lock (no parallel runs).
4. Actions execute FIFO by `createdAt`.
5. Success removes action and records processed id.
6. Failure increments attempts and schedules backoff metadata.
7. After 5 attempts action becomes `failed`.

## Conflict policy (manifest)

- Compare queued payload `lastUpdated` with server `lastUpdated`.
- If server is newer, keep server value and mark action reconciled.
- If timestamps are missing/equal, prefer server and reconcile.
- UI note: `One update was reconciled with newer server data.`

## Troubleshooting

- **Queue not draining:** verify network + Firebase connectivity banner.
- **Messages stuck queued:** tap **Sync now** in Chat and verify pending count drops.
- **Manifest failures:** use **Retry failed** then **Sync now** in manifest screen.
- **No offline data:** open the tour once online to hydrate the Tour Pack.

## Manual validation checklist

1. Login online and open Tour Home + Itinerary.
2. Disable network; reopen app and verify cached content appears.
3. Driver updates manifest offline; verify queued badge.
4. Send chat offline; verify queued message state.
5. Re-enable network; verify queue replays and statuses become synced/sent.

## Queue telemetry and operator alerting

`offlineSyncService` now emits structured telemetry via `loggerService` for replay lifecycle:

- `Offline replay started` with queue length, skipped failed actions count, and oldest queued action age.
- `Offline replay ended` with processed/failed totals and skipped failed actions count.
- Queue stats now include:
  - `oldestPendingAgeHours`
  - `skippedFailedActions`
  - `health` (`healthy`/`degraded`)
  - `healthWarnings` (`failed_actions_threshold`, `pending_age_threshold`, `skipped_failed_threshold`)

### Suggested dashboard widgets

- **Offline queue health (current):** show `health` and active `healthWarnings`.
- **Replay outcome trend:** sum of `processed` and `failed` per hour/day from replay-end logs.
- **Queue age monitor:** chart `oldestPendingAgeHours` over time.
- **Failed backlog monitor:** chart `failed` and `skippedFailedActions` counts.

### Suggested alert conditions for operations

Trigger warning alerts when any condition persists for 15+ minutes:

1. `health = degraded` for a driver session.
2. `failed > 3` actions in queue.
3. `oldestPendingAgeHours > 2`.
4. `skippedFailedActions > 5`.

Operational response:

- Ask driver/operator to open a connected screen and trigger replay.
- If failure count keeps growing, check Firebase connectivity + rules and inspect replay failure errors in logs.
