# Photo Upload Variant Contract (Phase 2)

## Queue handoff

`PHOTO_UPLOAD` queue actions should use `payloadVersion: 2` with a source-only upload shape:

- `idempotencyKey` (required)
- `localAssets.sourceUri` (required)
- `localAssets.previewUri` (optional for optimistic tile)
- `metadata.caption` (optional)

Legacy queue payloads without `payloadVersion` remain replay-compatible and are treated as Phase 1 payloads.

## DB lifecycle fields

New uploads should enter `group_tour_photos/*` or `private_tour_photos/*` with:

- `variantStatus: "processing"`
- `sourceUrl` (plus legacy-compatible `url` / `fullUrl`)
- `variantUpdatedAt`
- `variantError` (nullable)
- `variantVersion` (currently `2`)

Cloud Function variant generation updates records to:

- `variantStatus: "ready"` with `viewerUrl` and `thumbnailUrl`; or
- `variantStatus: "failed"` with `variantError`.

Compatibility behavior:

- Existing records without `variantStatus` are treated as display-ready if they already include a legacy display URL (`viewerUrl`, `url`, `fullUrl`, or `thumbnailUrl`).

## Deployment requirement (region alignment)

- `generatePhotoVariants` is pinned to `europe-west1` and must listen to a bucket in the same region.
- Set Functions param `PHOTO_VARIANTS_BUCKET` to your **europe-west1** Storage bucket name before deploy.
- If this param points to a `us-east1` (or any non-europe-west1) bucket, deploy will fail with a region-mismatch trigger error.
