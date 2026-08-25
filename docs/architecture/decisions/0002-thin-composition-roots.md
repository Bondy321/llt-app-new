# ADR 0002: Thin composition roots

Status: accepted.

`App.js` and `functions/index.js` only delegate/compose. Wiring remains visible, but business rules, paths, parsing, lifecycle implementation, and presentation are owned by focused modules. This keeps startup surfaces reviewable and makes import side effects testable.
