# Date Contract (Mobile + Web Admin)

To prevent parsing drift between clients, both mobile and web-admin use the same strict date contract:

## Accepted string formats

- UK: `dd/MM/yyyy` (example: `09/10/2025`)
- ISO: `yyyy-MM-dd` (example: `2025-10-09`)

No other string formats are accepted.

## Parsing rules

- Inputs are trimmed and validated against exact regex format.
- Calendar validity is enforced (e.g. `31/02/2025` and `2025-02-31` are rejected).
- Ambiguous or invalid values return structured validation errors:
  - `TYPE_ERROR`
  - `REQUIRED`
  - `INVALID_FORMAT`
  - `INVALID_DATE`

## Storage + display rules

- Canonical storage for tour start/end dates is UK format (`dd/MM/yyyy`).
- HTML date inputs use ISO format (`yyyy-MM-dd`) and must be converted strictly.
- UI display in web-admin should always flow through shared date formatter helpers.

## Implementations

- Web admin strict parser/formatter source: `web-admin/src/utils/dateUtils.js`
- Mobile strict start-date parser source: `services/itineraryDateParser.js`

When updating either implementation, keep this contract aligned to avoid cross-client behaviour drift.
