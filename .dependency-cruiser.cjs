'use strict';

module.exports = {
  forbidden: [
    {
      name: 'no-circular-production-dependencies',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'mobile-does-not-import-backend-or-admin',
      severity: 'error',
      from: { path: '^(?:App\\.js|src/|screens/|components/|hooks/|services/|utils/)' },
      to: { path: '^(?:functions/|web-admin/)' },
    },
    {
      name: 'functions-do-not-import-other-runtimes',
      severity: 'error',
      from: { path: '^functions/' },
      to: { path: '^(?:App\\.js|src/|screens/|components/|hooks/|services/|utils/|web-admin/)' },
    },
    {
      name: 'admin-does-not-import-other-runtimes',
      severity: 'error',
      from: { path: '^web-admin/' },
      to: { path: '^(?:App\\.js|src/|screens/|components/|hooks/|services/|utils/|functions/)' },
    },
    {
      name: 'mobile-shared-does-not-import-features-or-app',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^src/(?:features|app)/' },
    },
    {
      name: 'mobile-services-do-not-import-screens',
      severity: 'error',
      from: { path: '^(?:services/|src/.+/(?:data|domain)/)' },
      to: { path: '^screens/' },
    },
    {
      name: 'functions-infrastructure-does-not-import-domains',
      severity: 'error',
      from: { path: '^functions/src/infrastructure/' },
      to: { path: '^functions/src/domains/' },
    },
    {
      name: 'web-admin-shared-does-not-import-features',
      severity: 'error',
      from: { path: '^web-admin/src/shared/' },
      to: { path: '^web-admin/src/features/' },
    },
    {
      name: 'production-does-not-import-tests',
      severity: 'error',
      from: { pathNot: '(?:^|/)(?:tests|__tests__)/|\\.(?:test|spec)\\.' },
      to: { path: '(?:^|/)(?:tests|__tests__)/|\\.(?:test|spec)\\.' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: '(?:^|/)(?:node_modules|dist|build|coverage|generated|__snapshots__)(?:/|$)|\\.(?:test|spec)\\.',
    includeOnly: '^(?:App\\.js|firebase\\.js|components/|hooks/|screens/|services/|src/|utils/|functions/|web-admin/src/)',
    moduleSystems: ['cjs', 'es6'],
    tsConfig: { fileName: 'tsconfig.architecture.json' },
  },
};
