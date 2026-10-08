# Unreleased upstream security fixes

Reviewed 8 October 2026. npm still publishes `braces@3.0.3`, `node-forge@1.4.0`
and `sprintf-js@1.1.3` as the latest versions. GitHub lists no patched releases
for the three advisories below. The current root dependency tree installs
`sprintf-js@1.0.3` through argparse; an unexpected version or additional installed
copy requires review and fails installation/checking.

| Package | Advisory and upstream evidence | Local remediation |
| --- | --- | --- |
| braces 3.0.3 | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), [upstream issue 70](https://github.com/micromatch/braces/issues/70) | At parser nesting depth 128, treat the entire pattern as literal text. Iterative inspection/rendering handles deep or cyclic caller-supplied ASTs before the recursive compile/expand/stringify walkers run. Ordinary patterns retain upstream behavior. |
| node-forge 1.4.0 | [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv), [open upstream PR 1152](https://github.com/digitalbazaar/forge/pull/1152/files) | Backport the nested DigestAlgorithm element-count check. Accept an OID and its optional NULL parameters only; reject extra nested elements. |
| sprintf-js 1.0.3 | [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), [upstream issue 237](https://github.com/alexei/sprintf.js/issues/237) | Clamp numeric e/f/g precision to the ECMAScript maximum 100, with minimum 1 for g. Oversized precision safely renders at the supported bound. Other formatting and width behavior remains upstream. |

These are first-party patches, not published upstream releases. Upstream package
names, versions and lockfile tarball integrity stay truthful. The source
manifest pins SHA256 before/after source hashes, normalizing only CRLF to LF so
the same patch is verified on Windows and Linux. The added depth helper is
attested too. Installation validates the complete plan before modifying files;
unknown source, unexpected package/version/integrity, unlocked nested copies,
missing production packages and altered patched code all fail closed. Patch
targets, including new helper files and their parent directories, must resolve
inside the package; file symlinks are rejected before writing. Compiled deep
fallbacks escape regex metacharacters, so constructing a RegExp cannot reinterpret
the original literal as groups, alternatives or quantifiers. Expansion and
stringification preserve the original literal text.

The dependencies are reached by Node build/development tools: braces through
micromatch (Metro/Jest) and chokidar (Firebase CLI), node-forge through the Expo
CLI and code-signing certificates, and sprintf-js through argparse in the
Istanbul/Babel toolchain. They are retained without forcing Expo/RN downgrades.
This does not claim that advisory labels disappear from npm's registry.

`postinstall` applies the reviewed source changes. `security:patches:check` checks
installed code without changing it. `test:security` runs the behavior and policy
tests. The security audit runner first executes the bounded installed-code
regressions, then requests raw npm JSON for root, Functions and web admin.
It prints raw findings separately from verified mitigations. Only the exact
reviewed direct advisory records and propagated records whose entire `via`
graph resolves to those verified patches can be mitigated. Changed/new high or
critical advisories, unanchored cycles, missing graph nodes, malformed reports, failed
network operations and failed proofs still block release. Unresolved lower
severity findings remain visible under the existing high severity threshold.

Metro has legitimate circular propagated findings. Such a component must reach
real direct advisories, and every branch retains the severity of its unmitigated
direct findings. A patched high finding does not hide an unpatched moderate
finding or leave it incorrectly labelled high. Isolated cycles and missing graph
nodes retain their reported severity and cannot attest themselves.

Baseline proofs used isolated child processes with a 96 MB heap limit and timeout.
A 4,003-character nested brace compile pattern overflows a deliberately bounded
stack in unpatched code; six-byte `%.101f` terminates an unpatched asynchronous
formatter; a synthetic signed SHA256 DigestInfo with an extra nested OCTET STRING
is accepted by unpatched Forge. Installed patched-code tests cover the corresponding
malicious inputs, normal Metro globs/formatting, SHA256 signatures, omitted and
present NULL parameters, and malformed extra elements. No customer data or live
signing keys are used.

When maintainers publish fixes, compare their source/tests with these mitigations,
upgrade the affected dependency tree, remove its patch definition and manifest
entry, and require the raw audit plus regression tests to pass. Advisory record
changes deliberately force a fresh review; there is no time-based blanket
exception, advisory ignore list, or replacement package version.
