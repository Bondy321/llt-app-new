# ADR 0001: Feature-based boundaries

Status: accepted.

Organize product behavior by feature/domain, with presentation, orchestration, data, and domain policy separated inside that boundary. This makes ownership and tests local and prevents unrelated feature coupling. Cross-feature reuse must graduate to a narrow shared interface rather than importing private files.
