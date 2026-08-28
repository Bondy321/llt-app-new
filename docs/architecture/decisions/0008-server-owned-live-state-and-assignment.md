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
- `live_state_rollout/v1` is the sole private rollout authority. Missing state is
  compatibility; source activity never changes phase. Compatibility preserves the
  legacy public shape and shared writers. An authenticated, revision-checked admin
  mutation revision-checks phase changes. This release refuses cutover with
  `LIVE_STATE_CUTOVER_PREREQUISITE_NOT_MET`; future cutover characterization keeps
  `projectionRevision` and legacy-writer denial ready without making them operable.
- The safe order is Functions, stable-OFF policy materialisation, read-only strict
  preflight, strict rules, web admin, the 1.0.5 native binary, mixed-version
  observation, then continued compatibility. A later reviewed release may enable
  cutover only after legacy clients can show an explicit update-required outcome
  or no supported legacy clients remain. No deployment is performed by this change set.
- Manual pickups are assignment-owned server-private records. A trusted Function
  stamps the exact assignment revision while holding assignment locks; app-session
  lifecycle changes cannot erase them, while assignment changes, tour deletion,
  explicit compare-safe withdrawal, and bounded expiry do.
- Assignment or policy work above a synchronous bound must expose durable progress
  and resume; success is returned only after the authoritative mutation is complete.
