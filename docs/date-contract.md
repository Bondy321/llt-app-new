# Date Contract (Mobile + Web Admin)

This contract prevents locale drift (UK vs US parsing issues) across mobile and web-admin.

## Accepted date-only strings

- UK: `dd/MM/yyyy` (example: `09/10/2026`)
- ISO date: `yyyy-MM-dd` (example: `2026-10-09`)

No other date string shape is valid.

## Accepted timestamp strings

- Epoch milliseconds (`number` or numeric string)
- ISO-8601 datetime **with timezone** (`Z` or `+/-HH:mm`)

## Validation rules

- Inputs are trimmed and regex-validated before parsing.
- Calendar validity is required (`31/02/2026` is rejected).
- Unsupported values map to explicit errors (for forms) or null fallback (for display).

## Mandatory implementation rules

1. Never use `new Date(dateString)` on user/data payloads.
2. Never use `Date.parse(...)` outside strict utility gates.
3. For UK dates, parse manually (`day`, `month`, `year`) in strict helpers.
4. Tour start/end dates are stored canonically as UK format (`dd/MM/yyyy`).
5. HTML `<input type="date">` values are ISO (`yyyy-MM-dd`) and must convert via strict helpers.

## Shared references

- Mobile itinerary date parsing: `services/itineraryDateParser.js`
- Web-admin strict date/timestamp utilities: `web-admin/src/utils/dateUtils.js`
- Web-admin date display contract: `docs/date-contract-web-admin.md`

## QA minimums

- Mixed UK + ISO inputs in same dataset.
- Invalid leap day and invalid month/day combinations.
- Boundary display around DST transitions.
- Unsupported formats produce deterministic fallback text and no crashes.
