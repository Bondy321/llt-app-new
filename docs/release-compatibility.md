# Mobile release compatibility

The mobile runtime uses Expo's `appVersion` runtime policy. `package.json` is the
canonical marketing/runtime version source and `app.config.js` reads it directly.
The native graph prepared in August 2026 is version `1.0.5`; it must be shipped in
a new binary before an OTA for runtime `1.0.5` is useful.

`appVersion` remains deliberate. It provides readable release identities and the
least disruptive migration for installed `1.0.4` binaries. Expo fingerprinting is
available in SDK 55 and is useful as a diagnostic, but making the fingerprint the
runtime policy would create a new runtime after any conservative fingerprint input
changes. The repository instead enforces the version bump explicitly.

## Native compatibility guard

`npm run release:compatibility:check` compares base and head native-input snapshots.
The snapshot discovers and hashes:

- root production dependencies, overrides, and the non-development lock graph;
- `app.config.js` and its tracked local file/plugin references;
- EAS native build profiles and app-version source;
- every tracked custom config plugin beneath `plugins/`;
- every tracked iOS or Android native-project file, including projects added later.

A native-input change with the same runtime identity fails with the changed input
categories and an instruction to bump `package.json`. Normal JavaScript source
changes are deliberately outside this native snapshot.

CI passes the exact pull-request/push base and head SHAs. A local invocation compares
`HEAD` with the worktree so the guard can be run before committing.

## Binary and OTA profile parity

`npm run release:config:check` resolves the binary and update contexts for
development, preview, TestFlight, and production. It compares app/runtime version,
update URL, owner/project, plugins, store cleanup/autolinking/transport-security
decisions, safe `extra` values, and the TestFlight feature context. Failure output
contains field paths only and never environment values.

All local and CI OTA commands use `scripts/release/runEasUpdate.js`:

```text
npm run update:dev
npm run update:preview
npm run update:testflight
npm run update:prod
```

The helper owns channel, platform, EAS environment, `EAS_BUILD_PROFILE`, and the
TestFlight eligibility flag; callers cannot override those routing options.

Main pushes first run the read-only OTA planner. Changes that cannot affect the
mobile bundle are a no-op. Native or unknown changes stop at a manual/binary release
boundary. `workflow_dispatch` remains the explicit route after the matching binary
is available, and every actual release still requires successful CI for the exact
release SHA.

The SDK-local Expo CLI is locked through `package-lock.json`; release workflows pin EAS CLI to
`22.6.0` in `eas.json` and every release workflow. App Check remains intentionally
disabled: all reviewed client/backend release flags stay explicitly `false`.
