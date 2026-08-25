# ADR 0003: Deployment-safe shared contracts

Status: accepted.

Canonical definitions and fixtures live at repository root; deterministic generated adapters live inside each deployment package. This avoids unsupported Functions parent-directory runtime imports while keeping schemas synchronized. Generated files are checked, never edited manually.
