# ADR 0006: No full TypeScript conversion in the initial refactor

Status: accepted.

The refactor retains deployable JavaScript and adds a strict `allowJs`/`noEmit` base, declarations, JSDoc, and deliberately checked boundary modules. This prevents a structural change becoming a risky language migration. Typed coverage expands boundary by boundary once behavior and module ownership are stable.
