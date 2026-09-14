# Media URL signing and photo verification

Private and group photos use authenticated media endpoints that issue short-lived signed URLs. The runtime service account must be able to sign blobs with its own identity. Upload permissions alone are insufficient: uploads may return 200 while URL resolution returns 500.

Production uses custom role `projects/loch-lomond-travel/roles/lltMediaUrlSigner`, containing only `iam.serviceAccounts.signBlob`. The role is bound on service account `500767842880-compute@developer.gserviceaccount.com` to that same service account. It is not a project-wide grant. Do not replace this with public bucket access or a broader token-creator role.

Inspect both endpoints before changing runtime identities:

```powershell
gcloud functions describe resolveGroupPhotoMedia --gen2 --region=europe-west1 --project=loch-lomond-travel --format='value(serviceConfig.serviceAccountEmail)'
gcloud functions describe resolvePrivatePhotoMedia --gen2 --region=europe-west1 --project=loch-lomond-travel --format='value(serviceConfig.serviceAccountEmail)'
gcloud iam roles describe lltMediaUrlSigner --project=loch-lomond-travel
gcloud iam service-accounts get-iam-policy 500767842880-compute@developer.gserviceaccount.com --project=loch-lomond-travel
```

Allow IAM propagation before retrying signed-URL resolution. Validate upload, idempotent retry, source download, thumbnail/viewer readiness and download, chat attachment creation, and deletion using an isolated synthetic principal/tour; remove its Auth, database and Storage fixtures afterwards. Do not use customer identity tokens for release probes.

RTDB omits null-valued children. Session validation must accept absence only for schema-nullable fields (passenger driverId and unassigned-driver tourId). Preserve all role, identity, expiry, participant and assignment checks. A transaction's initial null value can also represent an empty SDK cache: return the observed null to permit a server comparison/retry, then inspect the committed snapshot before reporting success. Never interpret a truly deleted record as a successfully generated photo.

`npm run test:login:emulators` covers persisted login-to-media authorization, fresh-cache photo locks and preview finalization. The image transform in its preview test uses real Sharp; only object storage is simulated. Production preview verification remains separate from unit/emulator success.
