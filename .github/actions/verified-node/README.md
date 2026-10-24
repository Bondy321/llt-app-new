# Shell-only CI toolchain

The workflows use native Bash/Git/curl on `ubuntu-24.04`, local composite
actions containing only Bash steps, and reviewed checksum-pinned Node archives
from nodejs.org. No JavaScript action runs, so GitHub's independently managed
action Node runtime is neither used nor altered. The existing repository Node
certificate-trust guard remains mandatory before dependency installation.

This replaces the duties of `actions/checkout@v5`, `actions/setup-node@v5`, and
`actions/setup-java@v5`. Their JavaScript implementations and the old local
`runtime-trust` JavaScript probe are not invoked. The probe remains available
for a future separately reviewed return to JavaScript actions. There are no
external `uses` dependencies in these workflows. npm cache restoration is
intentionally removed; every dependency graph still uses `npm ci`.

The initial inline checkout fetches full heads/tags and the exact event SHA,
including pull-request merge SHAs, and verifies detached HEAD. Its read-only
token is supplied only in the checkout step's environment; an HTTP header is
passed in Git's process environment, never persisted in Git config. Manual
release ancestry refreshes use `verify-main.sh` with their own step-scoped token.
Existing API checks retain their explicit `GITHUB_TOKEN`. Any future `gh`
invocation must similarly receive a step-scoped `GH_TOKEN`; no ambient checkout
credential is available. Production environment approvals, exact-SHA CI gates,
and explicit publication prerequisites remain unchanged.

Node hashes are pinned in `bootstrap.sh` from the official release manifests:

- https://nodejs.org/dist/v22.23.4/SHASUMS256.txt
- https://nodejs.org/dist/v24.22.1/SHASUMS256.txt

Archives are checked before extraction or execution, and installed only in a
new directory beneath `RUNNER_TEMP`. Normal HTTPS verification remains enabled.
Java 21 is selected from `JAVA_HOME_21_X64` and its actual major version checked;
there is no silent version fallback. See the supported runner image inventory:
https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md.

Workflow source changes alone do not demonstrate a passing hosted run. Fresh
container/SDK and exact-head verification must complete on the resulting commit.
