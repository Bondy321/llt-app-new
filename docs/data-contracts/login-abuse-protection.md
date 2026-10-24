# Login abuse protection

Passenger and driver login require Firebase Authentication and use authoritative distributed rate
limits before issuing an active application session. The supported 1.1.0 public-launch
contract requires App Check. Deployed handlers verify production tokens even if an
obsolete disabled flag remains. Missing or invalid tokens never create authority.
Staff login additionally requires independent server-issued device enrolment; a
public driver ID and valid App Check token are insufficient.

Production and TestFlight mobile builds require:

```text
EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_USE_APPCHECK=true
EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_REQUIRE_APPCHECK=true
LLT_REQUIRE_PRODUCTION_APPCHECK=true
```

## Distributed quota store

The authoritative limiter is `functions/lib/loginRateLimiter.js`. It uses Realtime Database
transactions at `login_rate_limits/v1/{opaqueBucketKey}`. Transactions serialize competing
requests from different warm instances and cold starts, so horizontal Gen2 scaling cannot reset or
split a quota. Database rules deny all client reads and writes and index `expiresAtMs` for bounded
server cleanup queries.

Every login attempt consumes all three relevant buckets concurrently:

- credential: repeated attempts against the same credential combination;
- account: attempts against the same booking reference or driver code across Firebase auth UIDs;
- network: broad traffic from the same normalized client/network dimension.

The broad network dimension comes only from the platform-appended forwarding chain. Client IDs and
User-Agent values are not part of that bucket, so rotating caller-controlled headers cannot reset a
network quota. When the forwarding chain includes Google Front End's load-balancer hop, the
penultimate address is the trusted client address; attacker-prepended values are ignored.

Bucket keys contain labels plus truncated SHA-256 digests only. Records contain only version,
count, window/expiry timestamps, and last-attempt time. Never store raw booking references, emails,
driver codes, auth UIDs, IP addresses, client IDs, or user agents in this root.

Limiter storage errors fail closed with `503 SERVICE_UNAVAILABLE`. Counts saturate after denial to
avoid unbounded numeric growth. `cleanupExpiredLoginRateLimits` runs hourly, drains up to five
500-record batches per invocation, and reports whether a backlog remains. Each deletion is a
compare-and-delete transaction: a bucket reset by a concurrent login after the expiry query is
retained. Records are retained for 24 hours beyond the active window to make cleanup retry-safe.

## First-launch prerequisites

Register the actual iOS/Android App Check providers and admin web provider, then
verify tokens from matching 1.1.0 native binaries. The native dependency change
requires new binaries; an OTA cannot supply it. Review matching Functions, rules,
importer and admin revisions together. Manual publication requires exact-commit
CI and an explicit declaration that these prerequisites have been verified.
See the [first-launch checklist](../operations/first-public-launch-2026-10-24.md)
for the unperformed owner/provider/device checks. No deployment is implied by
this source contract and no production debug-token bypass is supported.
