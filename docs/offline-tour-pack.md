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
