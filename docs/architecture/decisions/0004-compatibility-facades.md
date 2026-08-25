# ADR 0004: Compatibility facades

Status: accepted.

Historic screen and service paths remain thin facades while implementations move behind them. Characterization tests lock exports and signatures. A facade is removed only after callers migrate and the removal is explicit, avoiding a repository-wide flag day.
