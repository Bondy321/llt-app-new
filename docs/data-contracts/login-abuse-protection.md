# Login abuse protection

Passenger and driver login require Firebase Authentication and use authoritative distributed rate
limits before issuing an active application session. App Check is intentionally disabled until the
production iOS and Android apps are registered. A deployed Gen2 runtime must set
`REQUIRE_APP_CHECK_FOR_LOGIN` explicitly: `false` is the approved current mode, `true` enables token
verification, and a missing value returns `503 SERVICE_UNAVAILABLE` so configuration loss fails
closed.

Production mobile builds currently set:

```text
EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_USE_APPCHECK=false
EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_REQUIRE_APPCHECK=false
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

## Deployment order

Current disabled-mode deployment:

1. Set both production EAS client flags to `false`.
2. Set `REQUIRE_APP_CHECK_FOR_LOGIN=false` and `REQUIRE_APP_CHECK_FOR_GROUP_MEDIA=false`.
3. Deploy Functions before publishing the compatible OTA.
4. Smoke-test authenticated login, media, logout, invalid credentials, stale sessions, and throttling.

Future enablement must register App Check for every production app first, validate legitimate tokens,
then change client and backend flags together in a staged rollout.

The fail-closed missing-setting check is a last line of defence, not a substitute for validating
production configuration. Production and TestFlight workflows pin the approved disabled mode
explicitly rather than inheriting stale secrets. Setting `LLT_REQUIRE_PRODUCTION_APPCHECK=true`
remains an opt-in rollout guard that rejects false client flags.
