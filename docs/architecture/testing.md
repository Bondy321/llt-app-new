# Architecture and test strategy

During a change, run the smallest affected behavior, contract, rule, and lint slices. Before release, run one clean-install full pass.

Core enforcement:

- `npm run contracts:check`: generated-copy freshness, fixtures, and Firebase rule parity.
- `npm run architecture:report`: deterministic inventory and metrics.
- `npm run architecture:check`: size/name limits and dependency-cruiser boundaries.
- `npm run lint`: runtime-specific ESLint rules.
- `npm run typecheck`: strict typed boundary checks without converting the legacy repository wholesale.
- `npm run test:architecture`: public exports, routes, triggers, heavy-import isolation, and tooling.
- `npm run verify:refactor`: normal non-emulator development gate.

Final verification also runs mobile, Functions, emulators, web-admin tests/build/lint, release security audit, supported Expo exports, Functions loading, and rendered admin QA. A command is reported as passed only if it exits successfully.

The `CI` workflow exposes these required status checks for branch protection: `Architecture & contracts`, `Mobile tests`, `Functions tests (Node 22)`, `Firebase rules`, `Web administration`, and `Security audit`. Repository administrators must configure them as required checks in GitHub; adding the workflow does not enable branch protection by itself.

Release workflows query the Actions API and require a successful `ci.yml` run for the exact release SHA. Existing EAS builds must additionally report the same Git commit before TestFlight submission.
