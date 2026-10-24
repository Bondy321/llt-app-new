# Staff device enrolment: first public launch

The public `D-...` driver ID identifies a driver. It is never a credential. A driver
sign-in requires a separate one-time device enrolment secret from an authorised
web administrator. Existing `drivers.authUid`, old profiles and custom claims do
not manufacture staff approval. Passenger sign-in remains booking/email with
independent version-2 device membership.

## Approval and redemption

`staffDeviceEnrolment` is an authenticated admin HTTP endpoint. It requires the
server-owned admin allowlist and a verified Firebase second-factor sign-in within
ten minutes. Production administration must enable Identity Platform TOTP MFA,
enrol the administrators and verify their email addresses. These are owner
account settings, not client flags. Driver privilege never implies admin privilege.

The Drivers panel creates and displays a 256-bit cryptographically random secret,
valid for ten minutes. Copy it directly to the approved driver. It is displayed
only in the current panel and never saved in browser storage. The server stores
its SHA-256 digest as the private `driver_enrolments` key, with bounded driver,
generation, expiry and redemption metadata; it never stores the plaintext secret.
Do not put codes in chat, profiles, manifests, diagnostics or customer data.

Redeemed proofs retain only a SHA-256 installation UID digest and a secret-bound
redemption digest, never the raw installation UID. These private audit fields
explain which approval won and prevent receipt reuse; they do not grant access.
Their authorization lifetime is bounded by the ten-minute expiry and current
installation/staff generations. Account deletion removes the active device record
and redacts any older raw-UID proofs in bounded indexed pages. A delayed redemption
therefore cannot recreate raw account linkage or supersede the permanent deletion
fence. The existing fifteen-minute policy-cleanup scheduler removes expired proof
evidence after thirty days, at most 100 indexed records per run, comparing each
complete observed record before deletion. Current staff-policy and permanent
installation fences remain independent of this bounded audit retention.

The exact installation UID wins a transaction on the secret record. Another UID
cannot redeem it. Same-installation retries use the deterministic redemption ID
and original installation epoch. A partially published operation can resume its
stored bounded publication; a completed operation returns only its exact current
session. Logout, a logical role switch, staff replacement/revocation or accepted
deletion supersedes that proof. Keeping or re-entering the old secret cannot reopen
staff mode. Dispatch must approve a genuinely new enrolment after explicit logout.

The approval authorises an **installation**, not the human holding the phone.
Drivers must log out before handing a shared phone to a passenger. Offline logout
remains blocked until server retirement and local recovery complete. Cold restore
may retain a valid current staff session; it does not redeem a public driver ID.

## Current authority and revocation

`driver_device_authorizations/{uid}` is private, server-owned and binds a driver,
staff-policy generation, redemption ID and exact session ID. Current driver
access additionally requires the `driver_staff_policy/{driverId}` generation and
the committed `app_session_authority/{uid}` session to agree. HTTP access checks,
RTDB rules, notification delivery and live-location projection enforce this proof.
Storage clients remain denied; media access goes through current-session Functions.

The existing single-device policy is an additional restriction, never a substitute
for staff approval. First claim is still serialised between approved installations.
`drivers.authUidStaffGeneration` distinguishes an obsolete scalar claim from a claim
made under current approval, allowing a genuinely approved replacement phone.

Replace/revoke advances the private staff generation immediately. Cleanup need not
finish before old privileged reads/writes are denied. Replace also creates a new
short-lived secret. The policy records its admin actor, action and time. Ordinary
issuance preserves the current generation so explicitly approved multi-device use
continues when single-device enforcement is disabled.

## Queued issuance boundary

### Current authority matrix

| Operation | Required current authority | Refused authority |
| --- | --- | --- |
| Passenger login on another phone | Verified booking reference and matching email; independently published current installation session and v2 device membership | Old scalar UID alone, withdrawn map membership, invalid booking/source roster |
| Driver installation approval | Existing driver record; allowlisted administrator with verified TOTP and authentication within ten minutes | Public driver ID, App Check alone, UI/profile admin or MFA flags |
| Driver login | Unexpired one-time secret redeemed to this installation, current staff generation, current device policy and assignment admission | A different phone's redemption, revoked generation, receipt superseded by logout or role switch |
| Driver session restore/use | Exact canonical session, committed installation authority, matching active device approval and staff generation, current policy/assignment | Legacy tester session, missing policy generation, copied profile or scalar claim alone |
| Staff recovery after interrupted publication | Same redeemed receipt and installation operation; current canonical session after commit | Different receipt owner or any superseding epoch |
| Admin replacement/revocation | Recent verified TOTP and server allowlist; advances driver staff generation | Client mutation of approval, enrolment or staff-policy roots |
| Passenger safety location | Current committed session; exact v2 participant membership for that tour | Previous role/session or a stale participant leaf alone |
| Background coach source | Current committed driver session, active tracking intent, exact staff approval and assignment | Public code, ended tracking session, obsolete installation/session generation |

Staff approval is approval of an installation, not proof of the human currently
holding the phone. Production TOTP enablement/enrolment, native App Check provider
configuration and physical-device acceptance remain separate release prerequisites;
synthetic emulator claims do not demonstrate those external owner steps.

`sessionPublicationAuthority.js` keeps a permanent per-installation epoch. Login
captures its predecessor before asynchronous verification, then compare-and-sets a
bounded prepared operation. The operation stores at most 120 update paths and a
128 KiB publication map. Its exact-path write manifest is private.

The publication uses Firebase Admin SDK's supported
`databaseAuthVariableOverride`, rather than the privileged default connection.
An ephemeral server-only top-level auth marker, installation UID, operation and
epoch identify the writer. Normal Firebase custom claims live under `auth.token`
and cannot manufacture the top-level server override.

Rules allow only manifest-listed issuance paths and validate the current prepared
epoch, expiry, current issuance lock owner, deletion barriers, staff generation, current driver policy and assignment, and final canonical session at
the actual server commit. The canonical session, profile, membership, grants,
notification ownership, staff approval and operation commit are one atomic update.
A queued old update is denied after a successor or tombstone, regardless of its
earlier lease check. There is no whole-database transaction. Ordinary client write
permissions explicitly exclude the internal issuer so it cannot fall back to a
successor's normal privileges. A failed/partial preparation grants no new access.

The new SDK regression queues the production issuance update on a real offline
Firebase connection, publishes successors or superseding actions on another, then
reconnects the old writer. It compares the complete successor authority roots,
including notification ownership and grants. This must pass against the exact
repository rules before release; code inspection alone is not acceptance evidence.

## Deletion admission recovery

Deletion first records a permanent `deletion_prepared` intent under the installation
fence, containing the exact receipt, captured private scope and bounded publication.
A failed write cannot reopen login, and a retry of the same receipt can complete the
atomic job, queue, tombstones and authority withdrawal without re-deriving scope from
a session that is no longer usable. Another receipt cannot adopt that intent.

The restricted admission commit requires this exact prepared epoch. Reconnecting an
old queued commit after recovery therefore cannot reset worker progress. Successful
session and deletion commits delete their captured publication and path manifest in
the same atomic update; the remaining installation fence has no copied profile,
passenger scope or job payload. A committed staff login retry validates the current
canonical session and minimal redemption receipt instead of retaining the payload.

Queued passenger publication also compares its captured raw booking tour against the current source, requires current login eligibility and an active resolved tour, and permits old bookings without source-roster metadata. Transfers and cancellations that happen after dispatch reject the obsolete write. The temporary booking capture is pruned atomically on commit.
