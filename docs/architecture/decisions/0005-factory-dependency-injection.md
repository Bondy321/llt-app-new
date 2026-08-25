# ADR 0005: Dependency injection through factories

Status: accepted.

Handlers and workflow runners receive dependencies through small factories or explicit parameters where isolation matters. No DI framework or service locator is introduced. Pure decisions remain ordinary functions and runtime adapters remain replaceable in focused tests.
