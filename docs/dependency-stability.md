# Dependency stability baseline

Prepared 8 October 2026 for launch preparation. The scope is dependency compatibility, security and reliable verification. Crash investigation is deferred; its separate diagnostics/rules changes are preserved in a local Git stash.

## Compatible updates

- Mobile retains Expo SDK 55, React Native 0.83.10 and React 19.2.0. Expo is 55.0.31, its development client is aligned to 55.0.40, and Firebase resolves to 12.19.0. Runtime/app version 1.0.6 identifies the changed native dependency graph.
- Functions retain Node 22 and their Firebase SDK majors. Sharp 0.35.5, gRPC 1.14.5, Busboy 3.2.2, proxy-addr 2.0.8 and qs 6.16.0 remove published findings. The unused `firebase-functions-test` dependency and its obsolete transitive tree are removed.
- Admin retains Firebase 12 and Vite 7. Vitest is 4.1.11; compatible transitive patches cover its tooling. Firestore's Node-only gRPC dependency uses the patched 1.13.6 release in the mobile/admin trees.
- The root CLI's FTP dependency is scoped to basic-ftp 6.2.2, and brace-expansion 5 uses 5.0.12. The installed tree remains internally consistent.

## Unreleased upstream fixes

Three installed packages have no published patched release: braces 3.0.3, node-forge 1.4.0 and sprintf-js 1.0.3. Reviewed first-party backports address the demonstrated defects and preserve ordinary behaviour. Installation checks exact source/integrity hashes; the audit gate runs real installed-code regression proofs. Unknown code or advisories fail rather than receiving a blanket exception. Details and primary sources are in [the patch notes](dependency-security-patches.md).

Raw npm retains the upstream advisory labels. Production audit findings are verified remediated; Functions and admin raw audits are zero. One moderate advisory remains in the root Firebase CLI's development-only OpenTelemetry chain, represented by three propagated package records. It remains visible under the existing high/critical release threshold; forcing the CLI onto an incompatible SDK major is not part of this baseline.

## Verification and workflow

Use a clean `npm ci`, then the security audit, Expo compatibility, architecture/lint/type checks, complete tests, admin build and affected Firebase integration checks. Run verification sequentially on the local computer. Node tests use at most two file workers; admin Vitest uses one thread worker. Assertions and timeouts stay intact.

Commit verified work and merge to main through GitHub's required checks. App version 1.0.6 requires a new matching mobile binary when we build the pilot release; committing code does not deploy backend packages or publish an app.
