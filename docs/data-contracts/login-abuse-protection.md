# Login abuse protection

Passenger and driver login are protected only after Firebase Authentication and App Check have
been validated. A deployed Gen2 runtime must have `REQUIRE_APP_CHECK_FOR_LOGIN=true`. If that
setting is missing or false, both login endpoints return `503 SERVICE_UNAVAILABLE`; they never
silently run without App Check. Tests and the Functions emulator may disable enforcement.

Production mobile builds must also enable:

```text
EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_USE_APPCHECK=true
EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_REQUIRE_APPCHECK=true
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

1. Register App Check for the production iOS and Android apps and validate legitimate tokens.
2. Set production EAS client flags to true.
3. Set `REQUIRE_APP_CHECK_FOR_LOGIN=true` in the Functions production environment.
4. Deploy Functions, including the cleanup schedule.
5. Smoke-test valid, missing-token, invalid-token, and throttled requests.

The fail-closed runtime check is a last line of defence, not a substitute for validating production
environment configuration before deployment. Production and TestFlight workflows do not provide
false defaults and set `LLT_REQUIRE_PRODUCTION_APPCHECK=true`, causing environment validation to
reject missing or false client flags. In a deployed Cloud Run runtime, `K_SERVICE` always wins over
test/emulator environment markers; those markers cannot turn production enforcement off.
