# Driver notification and session recovery

The 14 September 2026 incident combined repeated iOS native-token callbacks,
notification device locks left until expiry, and competing chat/location
projection leases during session cleanup. A successful later login did not mean
the original logout had completed successfully.

Notification registration now ignores unchanged native tokens. It retains the
existing durable retry for network/token failures and retries only transient
HTTP lock conflicts, with a bounded delay and the same mutation revision.
Changed tokens and changed session authority still trigger reconciliation.
The backend holds both mutation locks until persistence finishes, and lock
release resolves the server value when the Admin SDK begins with an empty cache.
Foreign owners remain protected.

Chat and location projection conflicts receive bounded retries that re-read
source state and authority. Driver location finalization and release handle an
empty SDK cache. Exhausted retries and non-contention failures still fail closed;
they are not reported as successful cleanup.

The account deletion queue has a server-only `dueAtMs` index. Its rules artifact
digests in the retention protocol must match this change. Retention remains
paused; previous protocol attestations cannot authorize this new rules artifact.

Release order: deploy affected Functions, deploy database rules, then publish the
mobile update. Preserve the native-only passenger origin configuration and
existing rollout flags. Validate driver preferences, logout and immediate login
through real Auth/RTDB HTTP emulator handlers, including concurrent projections,
then repeat with an isolated production fixture. Actual iOS callback behavior
still requires device acceptance of the new mobile update.
