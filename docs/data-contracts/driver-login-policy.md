# Driver Login Device Policy

## Purpose

`driver_login_policy/v1` controls whether one driver code may have one current handset or several. The policy is server-owned, client-unreadable, and defaults to multiple handsets when the record does not yet exist.

```json
{
  "schemaVersion": 1,
  "enforceSingleDevice": false,
  "generation": 0,
  "revision": 1,
  "updatedAtMs": 123,
  "updatedByHash": "24-character actor hash"
}
```

The API can report a missing record as the compatibility default
`enforceSingleDevice: false`, generation/revision zero. Before acquiring a login
admission, `verifyDriverLogin` transactionally materialises an explicit
generation-zero OFF record with revision one. Driver-only writes require that
valid materialised policy and exact generation; the missing default cannot grant
write authority. A malformed record fails closed, and clients cannot read,
create, change, or delete the policy.

## Authority

Every driver request still requires a current server-issued app session, matching Auth UID, driver principal and user profile, current tour assignment, and an unexpired session. Turning the policy off removes only the legacy scalar-claim requirement; it does not weaken any session or tour check.

Driver sessions carry server-only `driverLoginPolicyGeneration`. Rules and
Functions require it to equal the current materialised policy generation.

When enforcement is off, operational notifications fan out to every active, current-generation session for the assigned driver. When it is on, the same selection additionally requires `drivers/{driverId}/authUid` to equal that installation UID.

## Changes

The web-admin Settings screen calls `getDriverLoginPolicy` and `setDriverLoginPolicy`. Both endpoints require an authenticated operations admin and use optimistic `expectedRevision` comparison.

Normal logins do not use a repository-wide mutex. A short admission is created in
the policy transaction. With enforcement off, unrelated drivers and two UIDs for
the same driver may proceed concurrently. With enforcement on, a per-driver
`driver_login_claim_reservations/{driverId}` transaction serialises the claim.

Login admission uses `driverLoginClaimAllowedByPolicy`: an absent or blank claim
may enter that reservation, the same UID may reverify, and a different non-empty
UID is rejected when enforcement is enabled. Malformed claims fail closed.
`driverBindingAllowedByPolicy` remains strict for established-authority consumers,
including notification eligibility; admission is never itself operational authority.
The handler checks the fresh driver again under the reservation and preserves
policy generation, assignment, rate-limit and exact-owner rollback fences.

Policy transition and admission transactions distinguish a cold SDK cache from a
missing server record. A null proposal forces server comparison; the final
callback outcome and materialised policy determine acquisition. Missing policy
cannot manufacture an admission or bypass an expected positive revision.

Turning enforcement on:

1. transactionally changes the policy phase from `stable` to `draining`, which
   rejects new admissions with `DRIVER_POLICY_CHANGE_IN_PROGRESS`;
2. waits for admitted logins to finish or for their bounded admission to expire,
   while durable assignment admissions remain until explicit transition release;
3. transactionally commits the generation barrier and enforcement flag;
4. pages all app sessions and queues every exact old-generation session under
   `driver_login_policy_cleanup/v1/{authUid}`;
5. pages drivers and clears old scalar claims;
6. writes credential-free audit events under `driver_login_policy_events`;
7. returns to `stable`, after which the first verified handset per driver can claim it.

The transition cursor and counts live durably in `driver_login_policy/v1`; the
scheduled worker resumes 100 records per page. Correctness does not depend on the
old 60-second policy lock surviving the 120-second Function. More than 500
sessions are handled by continuation rather than rejected.

A login keeps its admission through server-owned session issuance. A policy-root
completion transaction verifies the admitted generation and phase, then removes
that exact admission; this is the login/policy linearization point. A drain may
start concurrently, but its generation barrier cannot overtake the admitted
login, and the endpoint does not return a failure after committing a new driver
session.

Cleanup disables all delivery for the old installation and removes its session-derived presence, read, typing, live-tracking and location state. Exact session IDs prevent a delayed cleanup job from ending a newer login. A scheduled worker retries lock-contended cleanup every 15 minutes, removes expired cleanup jobs after seven days, and removes expired audit events after one year.

Turning enforcement off is one non-destructive policy transaction. It does not
increment the generation or invalidate valid current sessions. Further verified
handsets can log in immediately.

All policy, admission, claim-reservation, cleanup, transition, and audit state
denies direct client reads and writes.

## Release order

Deploy compatible Functions before the associated rules and mobile delivery.
Wave 1 repairs do not require changing the live enforcement flag or advancing
the policy generation; they preserve the existing transition protocol. Its
1.0.7 mobile reconciliation change is JavaScript-only. See
`../operations/wave1-reliability-2026-10-17.md` for the coordinated consumer
inventory and verification record. Unsupported older driver-write clients still
do not satisfy the session/policy requirements. A repository merge performs no
Firebase deployment.
