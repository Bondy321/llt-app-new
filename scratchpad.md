# Engineering Scratchpad (Living Notes)

This file is intentionally lightweight and regularly rewritten.

## 2026-03-12 (mobile)

### What I changed

- Reduced noisy Firebase startup error logging when environment variables are intentionally absent (common in local unit tests and CI).
- Kept full error logging for real initialization failures, but downgraded the expected missing-config path to clear warning-level guidance.
- Aligned the auth-listener fallback log with the same behavior so startup output is less alarming and easier to scan.

### Why this matters before TestFlight

- Reliability work is not only runtime logic — observability quality matters too.
- Teams triaging launch blockers need console output where true failures stand out instantly; expected config gaps should not look like production breakage.
- Lower-noise logs make regression spotting faster during final QA and release candidate hardening.

### Personal note

I picked this because it removes friction every single day: cleaner signal, less false panic, and safer focus on real issues.
