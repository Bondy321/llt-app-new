# Enforced module boundaries

The authoritative executable policy is `.dependency-cruiser.cjs`, `eslint.config.mjs`, and `scripts/checkArchitecture.js`.

| Layer | May depend on | Must not depend on |
| --- | --- | --- |
| Mobile app composition | mobile features, screens, shared interfaces | Functions or web-admin runtime source |
| Mobile presentation | feature models/actions, public services, shared UI | Firebase SDK, fetch, persistent storage |
| Mobile services/repositories | shared adapters and domain utilities | screens or visual components |
| Shared mobile code | shared code | app or feature-private modules |
| Functions composition | domain public entries | business implementation in `index.js` |
| Functions domains | injected infrastructure and another domain's explicit `public.js`/`index.js` entry | another domain's private files, mobile, web-admin |
| Functions infrastructure | Firebase Admin/runtime SDKs | domain handlers |
| Web app shell | lazy feature entries, shared UI | feature-private data implementation |
| Web presentation | feature actions/models, repositories | direct Firebase calls |
| Contracts | data definitions/declarations | any runtime initialization |

Functions, mobile, and admin feature rules are generated for every current module directory, so a newly added cross-module private import fails `architecture:dependencies`. Generic string and passenger-field normalization belongs in `functions/src/infrastructure/validation`; business domains are not utility libraries.

Global rules reject circular production dependencies, production imports from tests, parent-runtime imports outside the Functions package, direct presentation Firebase/fetch/AsyncStorage/SecureStore access (including both `features/**/presentation/**` trees), and heavy SDK imports outside their approved adapter. File limits reject replacement monoliths and oversized vague `helpers`, `utils`, `common`, `misc`, or `shared` dumping grounds.
