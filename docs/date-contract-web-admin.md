# Web Admin Date Contract

## Purpose
This contract standardizes all date/timestamp handling in `web-admin` to prevent locale-dependent parsing drift (especially UK vs US ambiguities).

## Canonical Storage Formats

### 1) Date-only fields (tour scheduling)
- **Fields:** `tours/{tourId}/startDate`, `tours/{tourId}/endDate`
- **Accepted input formats:**
  - `dd/MM/yyyy` (UK)
  - `yyyy-MM-dd` (ISO date)
- **Canonical persisted format:** `dd/MM/yyyy`
- **Parsing rule:** must use `parseUKDateStrict` / `parseISODateStrict` only.

### 2) Timestamp fields (operational events)
- **Fields:** `drivers/{driverId}/createdAt`, `tour_manifests/.../assignedAt`, health sync timestamps, broadcast timestamps.
- **Accepted input formats:**
  - Epoch milliseconds (`number` or numeric string)
  - ISO-8601 datetime **with timezone** (e.g. `2026-02-01T10:15:00.000Z`, `2026-02-01T10:15:00+00:00`)
- **Canonical persisted format (new writes):**
  - ISO-8601 datetime for audit fields (`createdAt`, `assignedAt`, health `lastSuccessfulSyncAt`)
  - Epoch milliseconds for broadcast stream ordering (`createdAtMs`)
- **Parsing rule:** must use `parseTimestampStrict`/`toEpochMsStrict` only.

## Display Contract
- All rendered dates/times must route through `web-admin/src/utils/dateUtils.js` formatters:
  - `formatDateForDisplay` (date-only)
  - `formatDateRangeForDisplay`
  - `formatTimeForDisplay` (time-only)
  - `formatDateTimeForDisplay` (date + time)
  - `formatLongDateForDisplay` (verbose header date)
- Direct `new Date(string)`, `Date.parse(string)`, or ad-hoc `toLocale*` on unvalidated strings is disallowed in UI/service flows.

## Legacy Read Normalization
- Legacy timestamp payloads are normalized with `toEpochMsStrict`:
  - Numeric string epoch (`"1738411200000"`) → accepted
  - ISO datetime with timezone → accepted
  - Unsupported/invalid values → return `null` and show fallback UI text (e.g. `Unknown`, `Awaiting first sync`)
- Sorting logic must treat invalid/missing timestamps as lowest priority (`0`/`null`) rather than attempting implicit parsing.

## Timezone Boundary Expectations
- Day-level calculations normalize to start-of-day to avoid DST/hour drift in triage and comparisons.
- Timestamp displays always derive from strict parsed `Date` values and render in `en-GB` locale.

## Implementation Checklist
1. No `new Date(string)` in components/services.
2. No `Date.parse` outside `dateUtils` strict gate.
3. New writes use `nowAsISOString()` for ISO audit timestamps.
4. Tests cover mixed formats, invalid values, and timezone boundary behavior.
