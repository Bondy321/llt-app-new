# Photo Upload Variant Contract (Phase 2)

## Queue handoff

`PHOTO_UPLOAD` queue actions should use `payloadVersion: 2` with a source-only upload shape:

- `idempotencyKey` (required)
- `localAssets.sourceUri` (required)
- `localAssets.previewUri` (optional for optimistic tile)
- `metadata.caption` (optional)

Mobile upload preparation should only optimize the source upload file for v2 payloads. Viewer and thumbnail variants are server-owned so the app does not spend client CPU generating files that are not uploaded in the v2 queue handoff.

## DB lifecycle fields

New uploads should enter `group_tour_photos/*` or `private_tour_photos/*` with:

- `variantStatus: "processing"`
- `storagePath` for both group and private photos; durable media URLs are forbidden
- `variantUpdatedAt`
- `variantError` (nullable)
- `variantVersion` (currently `2`)

For private uploads, the owner bucket is an RTDB-safe key:
`private_tour_photos/{tourId}/{stablePassengerKey}` where
`stablePassengerKey = toRealtimeKeySegment(stablePassengerId)`. Photo record ownership fields such
as `userId` remain the raw `stablePassengerId`.

To avoid upload denials when identity binding writes are delayed, passenger profiles should also persist
the encoded owner fields used by rules:

- `users/{uid}/stablePassengerKey = toRealtimeKeySegment(stablePassengerId)`
- `users/{uid}/privatePhotoOwnerKey = toRealtimeKeySegment(privatePhotoOwnerId)`

After successful passenger verification, the backend also projects `privatePhotoOwnerKey` into a
signed Firebase Auth custom claim. Private Storage reads and writes require that claim to equal the
owner bucket. The client force-refreshes its ID token after verification, so a restored passenger
identity can immediately access the same private bucket while other authenticated users are denied.

Storage custom metadata is deliberately minimal. Client source objects retain only `authUid` (needed
for uploader-owned overwrite/delete enforcement), `visibility`, and `sourceRole`; stable passenger
IDs, booking-derived owner keys, tour IDs, idempotency keys, and upload timestamps must not be copied
into object metadata.

All photo records are path-authoritative. Durable Firebase download-token URLs must not be stored
for source, viewer, or thumbnail objects. `resolvePrivatePhotoMedia` accepts at most
50 exact photo IDs, verifies the Firebase bearer token and signed `privatePhotoOwnerKey`, validates
every path against the requested tour/owner prefix, and returns five-minute Cloud Storage signed
URLs. Backend RTDB reads and signing calls both use bounded concurrency; reads target only those exact
photo leaves and never download the owner album branch. The mobile service merges returned URLs into
in-memory photo objects only.

Group Storage is entirely server-mediated because Storage rules cannot query Realtime Database tour
membership. Direct client reads, uploads, overwrites, and deletes under `group_tour_photos/**` are
denied. `resolveGroupPhotoMedia`, `uploadGroupPhoto`, `deleteGroupPhoto`, and
`createGroupPhotoChatMessage` require Firebase Auth and App Check, confirm that the tour exists, then
authorize only an operations admin, a current `tours/{tourId}/participants/{authUid}` passenger with
an opaque identity, or a driver whose profile/Auth UID/current assignment all agree. Reads are
limited to 50 exact photo IDs and return five-minute signed URLs in memory. Uploads are capped at
10 MB, accept supported image types only, and use a deterministic idempotency key and server-owned
path. Group chat image messages persist `photoId`, never a media URL.

Before release, back up and dry-run the bounded hardening migration for every tour appearing in
either group-photo metadata or group chat. Deploy the server Functions and deny-all group Storage
rules before apply mode so a client cannot mint a replacement token during cleanup. The migration
derives missing Storage paths from all historical URL aliases, revokes tokens on every source and
variant object (including unreferenced objects), removes photo URL fields, and converts matching chat
image URLs to `photoId`. An existing chat-only object is recovered into deterministic path-only photo
metadata; a missing object has its dead URL removed without inventing media:

```bash
npm --prefix functions run harden:group-photos -- --tourId=5112D_8 --limit=100
npm --prefix functions run harden:group-photos -- --apply --tourId=5112D_8 --limit=100
```

Before deploying the restrictive Storage rules, inventory legacy records and tokens:

```bash
npm --prefix functions run harden:private-photos -- --dry-run --tourId=5112D_8 --ownerKey=OWNER_KEY --limit=50
npm --prefix functions run harden:private-photos -- --apply --tourId=5112D_8 --ownerKey=OWNER_KEY --limit=50
# Continue only when nextCursor is returned:
npm --prefix functions run harden:private-photos -- --apply --tourId=5112D_8 --ownerKey=OWNER_KEY --limit=50 --after=NEXT_CURSOR
```

Every run requires an exact tour and owner bucket and pages photo keys at that RTDB query boundary;
there is no whole-tree scan mode. Apply mode removes private RTDB URL fields and revokes
`firebaseStorageDownloadTokens` on source and variant objects. Missing objects are idempotent success;
other Storage failures stop before their record is sanitized. Always review dry-run counts first.
When the command returns `nextCursor`, continue with `--after=<nextCursor>` until it returns `null`;
bounded batches must not restart from the first record.

`resolvePrivatePhotoMedia` uses Cloud Storage V4 signing. The deployed Function service account must
be able to read the bucket, the Service Account Credentials API must be enabled, and the signer must
have `iam.serviceAccounts.signBlob` (normally through Service Account Token Creator on itself).

Release order is deliberate: deploy `verifyPassengerLogin` and `resolvePrivatePhotoMedia`, release
the client token-refresh/path-only reader, run and review the legacy hardening migration, then deploy
the restrictive Storage rules. Reversing that order can temporarily strand existing private albums.

Cloud Function variant generation updates group records to:

- `variantStatus: "ready"` with `viewerStoragePath` and `thumbnailStoragePath`; or
- `variantStatus: "failed"` with `variantError`.

Generated group variants retain only non-sensitive role metadata and no download token. Clients
cannot address derivative paths; authorized deletion is performed by `deleteGroupPhoto`.

Before deploying the derivative-path rule, refresh existing ready group variants one tour at a time
so legacy viewer/thumbnail objects also inherit their source uploader identity:

```bash
npm --prefix functions run backfill:photo-variants -- --dry-run --visibility=group --tourId=5112D_8 --refresh-group-ownership=true
npm --prefix functions run backfill:photo-variants -- --apply --visibility=group --tourId=5112D_8 --refresh-group-ownership=true
# Continue only when nextCursor is returned:
npm --prefix functions run backfill:photo-variants -- --apply --visibility=group --tourId=5112D_8 --refresh-group-ownership=true --after=NEXT_CURSOR
```

Private records use the same lifecycle status but retain only `viewerStoragePath` and
`thumbnailStoragePath`; display URLs are resolved in memory. The Storage-finalize handler joins the
record through the indexed `storagePath` and retries the short Storage/RTDB ordering race, so variant
generation no longer depends on sensitive correlation metadata.

Admin moderation of a reported group photo must call `removeReportedPhoto`. The Function reads the trusted report and photo record, deletes the source, viewer, and thumbnail Storage objects, then atomically removes RTDB metadata and marks the report `actioned`. Browser code must not treat metadata-only deletion as complete photo removal.

## Deployment requirement (region alignment)

- Cloud Storage triggers must run in the same region as the bucket they listen to.
- For the current Firebase free-tier setup, the default Storage bucket is `us-east1`, so `generatePhotoVariants` is deployed in `us-east1`.
- Other backend functions remain in `europe-west1`; this function is an intentional regional exception.

## Backfill / retry

Existing records missing `viewerUrl` or `thumbnailUrl`, or records with `variantStatus: "failed"`, can be inspected with:

```bash
npm --prefix functions run backfill:photo-variants -- --dry-run --limit=50
```

Apply with `--apply` after reviewing the dry-run output. Use `--visibility=group|private`, `--tourId=...`, and `--ownerKey=...` to narrow the run.
Apply runs across every tour require `--allow-full-scan`; prefer `--tourId=...` for production batches.
