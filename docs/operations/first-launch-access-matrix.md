# First-launch access boundary inventory

This inventory describes the implemented 1.1.0 contract. The integrated verification
record supplies actual pass/fail evidence; provider configuration and physical
device acceptance are separate. “Passenger” means a current committed session,
eligible source booking, exact v2 installation membership and matching principal.
“Driver” additionally means current staff approval, policy and assignment.

## Actors and data boundaries

| Boundary | Signed out / anonymous Auth only | Passenger A | Passenger B on another booking/tour | Second valid phone on A | Current assigned driver | Revoked driver | Operations admin | Background service |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Booking login | May attempt bounded credential verification | May reverify | Own credentials only | Independently verifies same booking | No passenger privilege from driver ID | No privilege from former role | Does not bypass passenger credential verifier | Not a customer login |
| Passenger trip | Denied | Allowlisted own party/tour | Own party only; A denied | Same party; independent session | Passenger endpoint denied | Denied | Admin APIs are separate | Exact server projection only |
| Whole booking / manifest | Denied | Denied | Denied | Denied | Assigned manifest via handler/native rules | Denied immediately | Current MFA/allowlist administration | Trusted source/manifest jobs |
| Group chat/gallery | Denied | Current tour only | A's tour denied | Same tour, current session | Assigned tour | Denied immediately | MFA admin group access/moderation | Validated trigger/cleanup scope |
| Private media | Denied | Own principal/tour | A's media denied | Shared booking principal where owned | No passenger-private authority | Denied | No arbitrary private signing privilege | Exact deletion owner/generation |
| Coach source write | Denied | Denied | Denied | Denied | Explicit tracking intent and exact session/assignment | Denied immediately | Cannot impersonate a driver sample | Validated source projection only |
| Passenger coach position | Denied | Current tour projection | A's tour denied | Same current tour | Assigned scope | Denied | Fleet projection | Exact current source only |
| Notice acknowledgement | Denied | Canonical principal and allowed scope | Own scope only | Same principal read state | Current driver principal | Denied | Administration separate | Bounded cleanup only |
| Device/consent mutation | Authenticated logged-out marketing is a separate supported path | Exact current installation via handler | Cannot mutate A | Independent device | Current signed-in authority even if unassigned | Cannot reuse old operational authority | No client profile grants | Restricted atomic publication |
| Session/identity/staff/assignment records | Client writes denied | Client writes denied | Client writes denied | Client writes denied | Client writes denied | Client writes denied | Dedicated checked handlers | Bounded server publication |
| Staff enrolment/revoke | Denied | Denied | Denied | Denied | Denied | Denied | Recent verified TOTP and server allowlist | No synthetic approval from old records |
| Tour edit/manual addition/delete | Denied | Denied | Denied | Denied | No browser-admin privilege | Denied | Checked handler plus lifecycle lease/revision | Importer shares publication boundary |
| Account deletion | Receipt-only recovery is redacted | Exact captured session/receipt | Cannot adopt A's receipt | Retains independent login; shared-content contract applies | Exact captured driver scope | Cannot acquire new deletion scope from old session | No arbitrary customer receipt adoption | Barriers, generations, Auth last |

No unexpected allowance is accepted as a compatibility exception. Negative
regressions cover parent writes, alternate roles under the same UID, forged
client fields/custom claims, replaced sessions, withdrawn source membership,
staff revocation and queued writes after deletion. Prior issued media URLs have
a bounded five-minute expiry; this is explicitly not instant URL revocation.
An offline phone cannot learn an unseen remote revocation: it may display only
permitted unexpired cached scope and must reverify before privileged network work.

## HTTP endpoints

The export inventory is `functions/src/compositionRoot.js`. Ordinary application
HTTP endpoints use the shared Auth/App Check boundary; production checks revoked
and disabled Firebase identities as well as token signature/expiry. Application
session and role checks remain necessary after transport authentication.

| Handler family | Exported endpoints | Additional admission |
| --- | --- | --- |
| Login | `verifyPassengerLogin`, `verifyDriverLogin` | Distributed credential/network quotas; booking/source proof or independent staff secret |
| Session | `endAppSession`, `revokeAppSession`, `reconcilePassengerRoleClaims` | Exact installation/session, restricted successor-safe withdrawal; privileged revoke policy |
| Trip/manifest | `getPassengerTripSnapshot`, `getTourManifest` | Own passenger projection or exact current driver assignment |
| Assignment/tracking | `assignDriverToTour`, `updateDriverLocationPickup`, `stopDriverTrackingSession` | Current driver/admin authorization; exact revision/session/intent |
| Group media | `resolveGroupPhotoMedia`, `uploadGroupPhoto`, `deleteGroupPhoto`, `createGroupPhotoChatMessage` | Current tour/owner, byte/decoded bounds, operation lock, lifecycle and object generations |
| Private media | `resolvePrivatePhotoMedia`, `uploadPrivatePhoto`, `deletePrivatePhoto` | Exact private principal and current tour; same bounded media protocol |
| Safety | `submitSafetyReport`, `getSafetyAlertDetail` | Current authorized scope; no promise of emergency-service or push delivery |
| Notifications | `updateNotificationDeviceRegistration`, `getMarketingNotificationDetail` | Exact device/consent/current ownership; authorized detail audience |
| Deletion | `requestAccountDeletion`, `getAccountDeletionStatus`, `retryAccountDeletion` | Captured session, private receipt, permanent barriers; redacted recovery after Auth removal |
| Admin | `staffDeviceEnrolment`, `createManualPassengerBooking`, `mutateTour`, `deleteTourData`, `removeReportedPhoto` | Server admin allowlist plus TOTP; bounded input and audit; shared publication/deletion protocol |
| Admin policy | `getDriverLoginPolicy`, `setDriverLoginPolicy`, `getLiveStateRollout`, `setLiveStateRollout` | Server admin authorization; coherent current policy/schema |
| Admin notifications | `previewNotificationAudience`, `createServerTestNotification`, `requeueNotificationJob` | MFA/allowlist, bounded audience, exact terminal/requeue fences |
| Service ingestion | `ingestDriverTourPacks` | IAM invoker restricted to the exact management runtime service account; not public mobile App Check admission |

## Native RTDB, Storage and background work

`database.rules.json` controls current-session reads/writes of chat, reactions,
notice read state, group/private metadata, tour projections, explicit tracking
intent/location sources, bounded boarding and enabled driver-pack actions.
Private booking identities, enrolments, issuance manifests, deletion work,
notification delivery queues/counters and importer journals are server-only.
The internal publication override is a top-level server Auth override: user custom
claims under `auth.token` cannot manufacture it. Ordinary permission branches
explicitly exclude internal writers so stale operations cannot fall through.

`storage_rules.json` denies ordinary client object access. Media handlers issue
short-lived authorized access and perform bounded writes/deletion. Background
triggers and scheduled workers use service authority and therefore validate their
own event generation, current source and ownership; client rules alone do not
secure an Admin SDK worker. The importer uses a restricted publication connection
whose current component leases are checked at database commit. Admin edits and
deletion use the same lifecycle boundary.

Actual regressions are retained in `tests/security`, `tests/firebaseRules`,
`sessionPublicationAuthority.emulator`, `notificationPublication.emulator`,
`mediaPublication.emulator`, `tourPublication.emulator`,
`accountDeletionContent.emulator`, and importer publication/transfer SDK tests.
These are synthetic fixtures; no customer credentials/content or real messages
are used to establish the matrix.
