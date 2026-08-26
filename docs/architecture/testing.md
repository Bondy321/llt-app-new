# Architecture and test strategy

During a change, run the smallest affected behavior, contract, rule, and lint slices. Before release, run one clean-install full pass.

Core enforcement:

- `npm run contracts:check`: generated-copy freshness, fixtures, and Firebase rule parity.
- `npm run architecture:report`: deterministic inventory and metrics.
- `npm run architecture:check`: size/name limits and dependency-cruiser boundaries.
- `npm run lint`: runtime-specific ESLint rules.
- `npm run typecheck`: strict `checkJs` coverage for generated declarations plus session/navigation, login/assignment, shared API/persistence, Function auth/HTTP/app-session/media-request, and admin API/session boundaries. The architecture suite inspects `tsc --listFilesOnly` so this scope cannot silently shrink.
- `npm run test:architecture`: public exports, routes, triggers, heavy-import isolation, CI wiring, typecheck-program coverage, focused production contract use, and presentation lint fixtures. This suite runs in both the normal root `npm test` path and the CI `Architecture & contracts` job.
- `npm run verify:refactor`: normal non-emulator development gate.

Final verification also runs mobile, Functions, emulators, web-admin tests/build/lint, release security audit, supported Expo exports, Functions loading, and rendered admin QA. A command is reported as passed only if it exits successfully.

The active GitHub `standard` ruleset for the default branch requires a pull request, an up-to-date branch, resolved conversations, and exactly these successful checks: `Architecture & contracts`, `Mobile tests`, `Functions tests (Node 22)`, `Firebase rules`, `Web administration`, and `Security audit`. It also blocks deletion and non-fast-forward updates. Approval count remains zero for the current sole-maintainer operating model; checks and pull requests remain mandatory.

Focused generated adapters validate persisted/remote sessions, passenger and driver login/assignment responses, group/private media resolution, and notification navigation payloads at their production consumers. Unknown or credential-bearing values fail through the existing safe response path without importing the complete schema bundle.

Release workflows query the Actions API and require a successful `ci.yml` run for the exact release SHA. Existing EAS builds must additionally report the same Git commit before TestFlight submission.
