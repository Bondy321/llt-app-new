# ADR 0008: Server-owned live-state projection and assignment

Date: 28 August 2026

## Status

Accepted for the 1.0.5 hardening release; not yet deployed.

## Decision

Location, presence, and typing writers own private app-session leaves. Retryable
Functions validate current authority and publish versioned compatibility
projections. A disconnect or cleanup operation can therefore affect only the
originating session, while existing passenger/chat subscribers keep their stable
read paths.

Driver assignment and unassignment are one backend mutation used by mobile and
web admin. The backend owns revision checks, locks, idempotency, canonical
multi-root changes, every active handset reconciliation, notification authority,
and bounded audit. The web admin is no longer an independent authority writer.

## Consequences

- Delayed source triggers cannot regress public state because projection writes
  carry monotonic revisions.
- A temporary, additive rules bridge permits an installed legacy client to keep
  writing only while the shared compatibility record has no server-owned
  `projectionRevision`. The first versioned server projection is an irreversible
  per-record cutover: subsequent legacy writes and stale `onDisconnect` actions
  are denied. Existing read shapes remain compatible throughout the bridge.
- The safe order is compatible Functions plus bridge rules, then the 1.0.5 native
  binary, then uptake/telemetry observation. Removing the legacy branch is a
  separate later backend release after the supported old-binary population is
  below the approved threshold. No deployment is performed by this change set.
- Assignment or policy work above a synchronous bound must expose durable progress
  and resume; success is returned only after the authoritative mutation is complete.
