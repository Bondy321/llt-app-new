# Operations Alerts Contract

Last updated: May 28, 2026

`ops_alerts` is the curated operations surface for device/app failures. It is intentionally separate from raw diagnostics under `logs/{userKey}/{sessionKey}`.

Use it for:

- major mobile logger events at `ERROR` or `FATAL`,
- global JS errors captured by crash diagnostics,
- compact, sanitised records that web-admin can subscribe to directly.

Do not use it for:

- raw stack traces,
- full log payloads,
- booking refs, emails, auth UIDs, push tokens, raw session IDs, passwords, driver codes, or authorization values.

## Path

```text
ops_alerts/{fingerprint}
```

`fingerprint` is deterministic and currently starts with `opa_`. Repeated sightings of the same sanitised failure update the same record instead of creating unlimited child records.

## Required Fields

```ts
{
  alertVersion: 1,
  fingerprint: string,
  createdAt: string,
  createdAtMs: number,
  lastSeenAt: string,
  lastSeenAtMs: number,
  severity: "info" | "warning" | "error" | "critical",
  level: "ERROR" | "FATAL",
  source: "mobile_logger" | "crash_diagnostics",
  component: string,
  message: string,
  status: "open" | "acknowledged" | "resolved",
  userKey: string,
  sessionKey: string,
  deviceInfo: {
    platform: string,
    version: string,
    model: string,
    appVersion?: string,
    appBuild?: string,
    osVersion?: string
  },
  summary: string,
  count: number
}
```

Optional fields:

```ts
{
  tourId?: string,
  role?: string,
  appContext?: {
    tourId?: string,
    role?: string,
    screen?: string,
    isFatal?: boolean
  },
  crashBreadcrumbSummary?: {
    count?: number,
    latest?: string
  },
  acknowledgedAtMs?: number,
  resolvedAtMs?: number,
  reopenedAtMs?: number,
  statusUpdatedAt?: string,
  statusUpdatedAtMs?: number,
  statusUpdatedBy?: string
}
```

## Producers

Mobile logger:

- `services/loggerService.js` still writes raw records to `/logs`.
- After a raw upload succeeds, `ERROR` and `FATAL` entries call `buildOpsAlertFromLog` and `createOrUpdateOpsAlert`.

Crash diagnostics:

- `services/crashDiagnosticsService.js` still writes snapshots under `/logs/{userKey}/{sessionKey}/crashDiagnostics`.
- Global error snapshots call `buildOpsAlertFromCrashSnapshot` and include only a bounded breadcrumb summary.

Pure helpers live in:

```text
services/opsAlertService.js
```

## Dedupe

The fingerprint is based on sanitised source, level, component, message, user display key, device/app context, tour/role context, and a hash of stack content when available. Raw stack content is never written into `ops_alerts`.

When an existing alert is seen again:

- `count` increments,
- `lastSeenAt` and `lastSeenAtMs` move forward,
- acknowledged alerts stay acknowledged,
- resolved alerts reopen to `open` and set `reopenedAtMs`.

## Rules and Indexes

`database.rules.json` protects `ops_alerts` with:

- admin-only reads,
- admin manage rights,
- authenticated mobile create/update only for schema-valid, bounded records,
- blocked unknown fields,
- indexes on `createdAtMs`, `lastSeenAtMs`, `severity`, and `status`.

Mobile writes cannot acknowledge or resolve alerts. Web-admin status actions write only sanitised admin status fields.

## Web Admin

Web-admin must subscribe to bounded `ops_alerts` queries, not to `/logs`.

Service helpers:

```text
web-admin/src/services/opsAlertService.js
```

Dashboard surface:

```text
web-admin/src/components/Dashboard.jsx
```

The dashboard displays severity, status, component/source, message, affected masked user/session/device, app context, count, timestamps, and crash breadcrumb summary where available.
