# Web Admin Date + Timestamp Contract

Web-admin must use strict date/timestamp parsing utilities to avoid locale-dependent behavior.

## Canonical storage

### Date-only fields

- Paths: `tours/{tourId}/startDate`, `tours/{tourId}/endDate`
- Accepted inputs: `dd/MM/yyyy` or `yyyy-MM-dd`
- Canonical persisted shape: `dd/MM/yyyy`

### Timestamp fields

- Typical paths: `drivers/*/createdAt`, `tour_manifests/*/assignedAt`, sync/audit metadata
- Accepted inputs:
  - epoch milliseconds (number or numeric string)
  - ISO datetime with timezone
- Canonical persisted shape:
  - ISO datetime for audit fields (ex: `createdAt`, `assignedAt`)
  - epoch ms only where ordering streams require numeric sorting (ex: `createdAtMs`)

## Allowed utility surface

Use only `web-admin/src/utils/dateUtils.js` for parsing and display:

- Parsing/normalization: `parseUKDateStrict`, `parseISODateStrict`, `parseTimestampStrict`, `toEpochMsStrict`
- Formatting: `formatDateForDisplay`, `formatDateRangeForDisplay`, `formatTimeForDisplay`, `formatDateTimeForDisplay`, `formatLongDateForDisplay`

## Disallowed patterns

- `new Date(unvalidatedString)` in components/services.
- `Date.parse(...)` directly in UI/business logic.
- ad-hoc locale formatting from raw database values.

## Fallback behavior

When values are invalid/unsupported:

- return `null` from strict conversion helpers,
- render stable fallback copy (`Unknown`, `Awaiting first sync`, etc.),
- sort invalid timestamps as lowest-priority (`0` or `null`) rather than implicit parsing.

## Implementation checklist

1. New reads pass through strict normalizers.
2. New writes use explicit converter helpers (`nowAsISOString` / strict date serializers).
3. Tests cover mixed formats, invalid values, and timezone boundary rendering.
