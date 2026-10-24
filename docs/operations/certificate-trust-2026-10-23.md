# Certificate-trust remediation — 23 October 2026

## Scope and source changes

This remediation preserves the application's existing package graph and Node major
versions. No npm lockfile, business logic, authentication contract, database rule,
mobile version or native dependency changed. Wave 1 source changes already on main
remain a separate, unreleased application change; they were not deployed to refresh
Google's runtime. No mobile binary or OTA was published for this remediation.

- CI and release workflows select Node **24.22.1**, with **22.23.4** for Functions.
- `scripts/security/nodeRuntimeTrust.js` checks the executable security floor,
  bundled and effective certificate stores, and enabled TLS verification before
  installation/release tools run. Tests use the public affected root as a negative
  fixture, never as an installed trust anchor.
- EAS profiles inherit Node 24.22.1; the pre-install hook checks the runtime.
- EAS's build-tool `node` field does not affect the shipped native compatibility
  fingerprint. Other profile inputs still do. An `eas.json` change now requires
  manual OTA release planning, so this tooling correction cannot automatically
  publish the pending application source.
- Importer remediation is recorded in the companion repository's
  `docs/certificate-trust-2026-10-23.md`. Its immutable production image was updated;
  all 28 old/new `/app/src` files have identical SHA-256 hashes.

The [Node advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
requires executable fixes as well as root removal because compromised intermediate
keys are also rejected. Python requirements follow the
[Python incident notice](https://discuss.python.org/t/information-for-python-users-regarding-emudhra-emsign-ca-certificate-security-incident/109576)
and [certifi advisory](https://github.com/advisories/GHSA-6q48-6c7w-9gw2).

## Managed Functions: configured policy versus observed execution

Read-only inventory found **112 Functions**, all `nodejs22` and all configured with
`automaticUpdatePolicy`. Google applies these base-image updates independently of
application redeployment. See [Google's automatic-update documentation](https://docs.cloud.google.com/run/docs/configuring/services/automatic-base-image-updates)
and [Functions execution-environment policy](https://docs.cloud.google.com/functions/docs/securing/execution-environment-security).

Current serving logs identify:

```text
us-docker.pkg.dev/serverless-runtimes/google-22-full/runtimes/nodejs22:nodejs22_20261022_22_23_4_RC01
```

Cloud Build `5deeab3b-b044-45a9-b2f6-bae257891e21` independently inspected that
image, without executing LLT application code. Immutable image:

```text
us-docker.pkg.dev/serverless-runtimes/google-22-full/runtimes/nodejs22@sha256:f3a691db48f5a1c63c29afd12756f01bd7eb7b984cec0b567d58e553a8b024b4
```

Actual executable: **Node 22.23.4**, OpenSSL **3.5.9**, **116** bundled roots,
affected G3 root absent. Fresh serving evidence after safe HTTP probes confirms
this image for `verifyPassengerLogin`, `verifyDriverLogin`,
`getPassengerTripSnapshot` and `getTourManifest`. The initial inventory had 13
services with startup observations: 12 latest observations were patched; one
`projectdashboardparticipant` observation at 00:26 UTC predated rollout and still
named 22.23.2. Inactive/unobserved Functions have not individually demonstrated
their current runtime. Do not convert the 112-policy inventory into a claim that
112 serving instances were tested. No Functions source deployment was performed.

## Live application checks and importer limitation

Verified normal TLS and the following read-only public boundaries:

| Surface | Result |
| --- | --- |
| Admin hosting | HTTP 200, expected LLT application shell |
| Passenger login with empty request | HTTP 400, `INVALID_INPUT` |
| Driver login with empty request | HTTP 401, `INVALID_CREDENTIALS` |
| Passenger trip snapshot with empty request | HTTP 400, `INVALID_INPUT` |
| Tour manifest with empty request | HTTP 401, `INVALID_CREDENTIALS` |

These are availability and negative admission checks, not positive customer-login,
authenticated admin-screen or physical-device acceptance. Positive login/session
and trip/manifest behavior is covered by repository and emulator tests. Existing
TestFlight device acceptance is historical evidence, not a new test of this change.

The replacement importer fetched and parsed the 23 October 07:00 report batch.
Read-only Cloud Run execution `llt-app-sync-daily-wzgz6` then failed safely with
`SOURCE_PUBLICATION_BOOKING_TOUR_CONFLICT`, independently reproducing the current
source-ownership blocker. Of 12 incoming tour moves, 11 were source-managed and
one was unowned/legacy. Do not adopt or overwrite that record without confirming
ownership and preserving manual/history data. No live import was executed here.

Database aggregate counts and roster states were unchanged before/after testing.
Latest published source dates still end at **17 October**; no 23 October roster
publication was observed. Certificate remediation therefore does not constitute
successful ingestion recovery. Recovery requires resolving the single ownership
case, revalidating the current report receipt and full transfer-journal preflight,
then performing and verifying the documented safe live publication.

## Verification and evidence

Local evidence is outside both Git repositories:
`../verification/2026-10-23-certificate-remediation/` relative to App_Full's child
repository. Evidence files contain aggregate/sanitised results, no exported
passenger records or credentials.

- `app-gate-results.json` and `app-*.log`: sequential local gates on patched Node.
- `node-trust-focused.log`: 33 targeted trust, native compatibility and release
  planner tests passed, zero skips.
- `runtime-base-observations.json`, `runtime-latest-by-service.json`,
  `runtime-smoke-observations.json`, `managed-node-image-inspection.log`:
  policy/startup/image evidence described above.
- `production-http-smoke.json`: the five public-boundary probes.
- `source-hash-comparison.json`, `source-baseline.json`, `source-after.json`:
  deployed importer source equivalence and unchanged aggregate data.

Local dependency installations were reused because all three npm dependency
graphs are unchanged. PR CI performs clean `npm ci` on the final source. Record
exact-head results separately; do not describe local runs as clean installations.

The complete local `test:all` run passed **1,754 tests** with zero failures/skips;
Functions were additionally checked on Node 22 (**671 passed**), login/session
emulators (**89 passed**) and rules emulators (**223 passed**). Refactor verification,
native/release configuration, web build/lint, efficiency and release audit passed.
The audit still reports four unresolved **moderate development-tooling** records
(`@google-cloud/pubsub`, `@opentelemetry/core`, `firebase-tools`, `ip-address`).
There are no unresolved high/critical findings under the existing audited patch
policy; raw registry labels are retained and verified mitigations remain visible.
This is not a zero-advisory claim or a new exception to that policy.

GitHub JavaScript actions use the runner-owned Node independently of setup-node.
Check each final job's `Set up job` runner version as well as the selected Node
guard. Official [runner 2.338.1 source](https://raw.githubusercontent.com/actions/runner/v2.338.1/src/Misc/externals.sh)
packages Node 24.22.1; 2.338.0 packages the older 24.21.0. Latest release availability
does not establish the runner actually used. EAS remote build execution remains
unobserved because no binary build was authorized or needed.

Initial PR validation was green: app run `39947049663` (all six required jobs)
and importer run `39946925468` (fresh container build/tests). **Every job reported
runner 2.338.0**, whose published runner source packages Node 24.21.0, below the
incident security floor. The selected Node executable was independently verified
as patched in all app jobs, but the runner-owned JavaScript-action executable was
not directly inspected. Its patch status is an outstanding provider dependency;
do not claim the entire GitHub-hosted environment is remediated from those green
checks. Confirm an actually patched action runtime before release sign-off.

## Deployment and rollback

Production importer, project `loch-lomond-travel`, job `llt-app-sync-daily`,
region `europe-west1`:

```text
europe-west2-docker.pkg.dev/loch-lomond-travel/llt-sync/llt-app-sync@sha256:3d902f555cbce27c270b1060888f6f8185c1b8b053345d19f4407717b4c7d4a4
```

Python **3.14.9**, pip **26.2.2**, certifi **2026.10.19**. Every other installed
Python library matched the former deployed image. LiteLLM and Pillow are absent
from the inspected deployed/runtime dependency graphs; no unrelated upgrades were
introduced. Scheduler, credentials/scopes, service account, secret mounts, arguments,
regions, retries and timeouts remain unchanged. Read-only execution overrides did
not change the persisted job configuration.

Emergency importer image rollback (restores vulnerable trust material; prefer a
corrected rebuild and use only for a confirmed functional emergency):

```sh
gcloud run jobs update llt-app-sync-daily --project=loch-lomond-travel --region=europe-west1 --image=europe-west2-docker.pkg.dev/loch-lomond-travel/llt-sync/llt-app-sync@sha256:72fc1395fb76bca4fe79ed2a8e4404f4d0462f872ada7e41eda9d0b28e065341
```

No rollback was executed. There is no application deployment to roll back; do not
reverse Google's managed security patch or publish an older vulnerable toolchain.

## 24 October recovery reference

The earlier import blocker was subsequently resolved by importer PR6 and the recorded 23 October successful execution. See [first-launch recovery context](first-public-launch-2026-10-24.md#import-history-correction). This preserves the earlier investigation timeline; it is not a new import execution or a claim that the later transfer-code change was source-identical.


## 24 October dependency advisory follow-up

The fresh audit also reported [Zod GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) and [body-parser GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828). These are separate from certificate trust and the existing hash-attested Forge patch; neither advisory is added to an audit exception.

The candidate overrides keep body-parser consumers on their existing major: version 1 resolves to **1.20.9**, version 2 to **2.4.0**. Root tooling includes both majors; Functions uses version 2. The regression launches a bounded separate Node process against each actual Express/MCP-resolved parser, sends valid plain/compressed JSON, delivers compressed-frame trailing bytes after the decoder has finished, checks another raw-body consumer still receives the entire request, checks malformed/oversized JSON rejection, then sends another valid request. An uncaught decoder error fails the child; no exception handler masks a crash.

Zod version-4 consumers resolve to **4.6.6**. Expo CLI **55.0.36** alone receives a reviewed version-3-to-4 override. Source inspection found two direct consumers: `DevToolsPlugin.schema.js` and `createMCPDevToolsExtensionSchema.js`. They use object/enum/array/optional/readonly/strict validation and `.safeParse`; callers read `.error.issues` or `.error.message`. The installed MCP SDK explicitly supports version-4 schemas and uses its version-4 JSON Schema conversion branch. Tests load the actual installed Expo schemas and output consumer, register the generated schema with the actual MCP SDK over an in-memory transport, list the resulting JSON Schema, and verify valid calls and rejected unknown commands/fields/types. The override is pinned to that CLI version so an unrelated future version does not silently inherit this review.

The [upstream Zod fix](https://github.com/colinhacks/zod/commit/a0ebf97) rejects oversized **constrained** arrays, sets and maps before walking their elements. The regression checks this behavior with 20,000 entries, zero element visits and one size error, in interpreted and compiled configurations, plus ordinary valid input. This does not claim arbitrary unbounded schemas become resource-safe, or that the legacy `zod/v3` compatibility API bundled in version 4 received the version-4 patch. Expo uses the version-4 default entrypoint after this change.

These additions are included by the mandatory `tests/security/*.test.js` gate. All changed dependency graphs received clean installations, followed by fresh audits and actual consumer regressions. The 24 October security gate passed 58 tests with zero failures or skips. The fresh audit retained seven raw high records with verified installed mitigations, zero unresolved high/critical findings, and five moderate development-tooling records. Full integrated and delivery results belong in the [first-launch evidence report](first-public-launch-verification-2026-10-24.md).

### Additional development-tool Undici audit findings

The final fresh audit also identified vulnerable development-tool copies of Undici. The reviewed installed consumers were Firebase CLI 15.33.0 (`^6.19.0`, installed 6.29.0), node-gyp 13.0.1 (`^8.4.1`, installed 8.11.2), and admin jsdom 28.1.0 (`^7.21.0`, installed 7.30.0). Narrow range overrides retain those majors and resolve **6.29.1**, **8.12.2**, and **7.30.1**, respectively. Firebase CLI, node-gyp and jsdom themselves are not upgraded. The separate admin hooks lint dependency also receives the same-major Zod **4.6.6** override; it explicitly consumes `zod/v4`.

Official upstream reports identify an [excessive content-encoding process crash](https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c), [lost custom TLS verification callbacks](https://github.com/nodejs/undici/security/advisories/GHSA-2m5v-pch6-74hx), and a [TLS renegotiation process crash](https://github.com/nodejs/undici/security/advisories/GHSA-qrxm-fqhp-jwvm), with these patched versions. The version-7/8 releases additionally fix [cross-origin shared-cache redirect confusion](https://github.com/nodejs/undici/security/advisories/GHSA-4w7w-5xrc-9h26). That cache advisory requires a particular interceptor composition; the review does not claim the app uses it. All identified installed copies are patched rather than suppressing advisories based on reachability.

`undiciOctober24.test.js` resolves each consumer's actual package, verifies lock/install parity and unchanged majors, and runs a separate crash-regression process per copy. Synthetic loopback responses exceed the content-encoding limit and close before completing their bodies; the child must reject the response, remain alive, and handle a subsequent valid request without any uncaught-exception handler. Another regression verifies the actual Agent preserves the exact custom TLS callback when constructing its per-origin pool. This checks callback forwarding, not a live certificate-renegotiation attack. Consumer compatibility exercises Firebase CLI's `compress:false` HTTP adapter, node-gyp's real download helper, and jsdom's `fromURL` parser. Admin hooks lint retains valid code and detects conditional hooks; its patched Zod is also included in the bounded-collection regression.

Node's built-in fetch is a separate copy that npm overrides cannot replace. Read-only inspection of the trusted Node 24.22.1 executable returned bundled Undici **7.30.1**; Node 22.23.4 returned **6.29.1**. The regression also checks the active runtime's bundled version is patched. Clean installations, all consumer regressions and the fresh audit passed. Earlier cold consumer-load attempts intermittently timed out before requests began; those failures remain recorded. Security files now execute sequentially to reduce competing dependency loads. All 58 checks subsequently passed both independently and within the full 1,918-test run, with the original 15-second child limits unchanged. The precise operating-system scheduling or I/O cause was not established. No deployment or physical-device acceptance follows from these local results.
