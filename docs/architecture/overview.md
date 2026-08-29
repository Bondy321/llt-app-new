# Architecture overview

The repository is organised around composition roots, feature/domain modules, shared infrastructure, and compatibility entrypoints. The outer files wire dependencies; they do not own business rules.

```text
mobile App.js -> src/app -> screens/controllers -> feature views + services -> adapters
functions/index.js -> compositionRoot -> domains -> infrastructure adapters
web-admin App.jsx -> lazy section route -> feature presentation -> services/repositories
all runtimes -> generated local contract adapter <- contracts/definitions + fixtures
```

Dependency direction is inward: composition may depend on features and shared modules; features may depend on their own internals and public shared interfaces; infrastructure implements those interfaces. Shared code never imports an application or feature. Presentation never imports Firebase, persistence, or raw HTTP clients.

## Directory purposes

- `src/app`: mobile application composition, routing, session orchestration, notifications, and driver/passenger login runners.
- `components/<feature>` and `screens`: bounded feature presentation/controllers plus stable screen entrypoints.
- `services/<domain>`: mobile repositories, commands, subscriptions, API clients, and persistence adapters. Root service files remain compatibility facades.
- `src/shared`: runtime-neutral configuration and generated contract adapters.
- `functions/src/domains`: backend decisions and handlers by business domain.
- `functions/src/infrastructure`: Firebase Admin, HTTP, logging, rate limiting, notifications, and Storage adapters.
- `web-admin/src/features`: bounded admin feature presentation/domain/data modules.
- `contracts`: canonical data-only definitions, fixtures, declarations, and generated deployment-local adapters.
- `tests/architecture` and `tests/contracts`: public-surface, boundary, trigger, schema, and parity guards.

## Where new work goes

- Add a mobile feature beneath a named feature folder, expose a small screen/controller entry, and register its stable route in `src/app/navigation/routeRenderers.js`.
- Add a Function handler in its domain, inject shared infrastructure, then export it once from `functions/src/compositionRoot.js`. Never put request parsing or paths in `functions/index.js`.
- Add an admin section as a lazy route and keep reads/mutations behind its service or repository.
- Firebase SDK calls belong in Firebase/repository adapters; HTTP calls belong in API clients; AsyncStorage/SecureStore calls belong in persistence adapters.
- Change a cross-runtime shape in `contracts/definitions/contracts.v1.json`, update fixtures, run `npm run contracts:generate`, and verify rules parity with `npm run contracts:check`.
- Remove a compatibility facade only after all consumers move and public API characterization proves that removal is deliberate.

See [module boundaries](./module-boundaries.md), [testing](./testing.md), and the decision records under
`decisions/`. Server-owned account deletion is defined by
[ADR 0009](./decisions/0009-server-owned-account-deletion.md) and the
[account-deletion contract](../data-contracts/account-deletion.md).
