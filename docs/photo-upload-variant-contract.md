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

- Cloud Storage triggers must run in the same region as the bucket they listen to.
- For the current Firebase free-tier setup, the default Storage bucket is `us-east1`, so `generatePhotoVariants` is deployed in `us-east1`.
- Other backend functions remain in `europe-west1`; this function is an intentional regional exception.
