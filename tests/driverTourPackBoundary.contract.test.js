const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');

// Server-writer fences may wrap a closed rule without granting any access.
// Evaluate each closed expression for ordinary and privileged writer identities.
const assertClosedRule = expression => {
  if (typeof expression === 'boolean') return assert.equal(expression, false);
  for (const auth of [null, { uid: 'synthetic' },
    { uid: 'synthetic', token: { lltMediaPublisher: true } },
    { uid: 'synthetic', lltSessionIssuer: true }, { uid: 'synthetic', lltTourPublisher: true },
    { uid: 'synthetic', lltNotificationIssuer: true }, { uid: 'synthetic', lltMediaPublisher: true }]) {
    assert.equal(new Function('auth', `return (${expression});`)(auth), false);
  }
};
const assertCurrentDriverAuthority = expression => {
  for (const boundary of ['app_session_authority', 'driver_device_authorizations', 'driver_staff_policy']) {
    assert.ok(expression.includes(boundary), `missing ${boundary} authority`);
  }
  assert.match(expression, /committed/);
};

test('Gate 6 opens only exact coherent-driver pack reads and keeps server roots private', () => {
  const rules = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'database.rules.json'), 'utf8')).rules;
  const packs = rules.driver_tour_packs;
  assertClosedRule(packs['.read']);
  assertClosedRule(packs['.write']);
  assert.ok(packs['.indexOn'].includes('expiresAtMs'));
  assertCurrentDriverAuthority(packs.$departureKey['.read']);
  assert.match(packs.$departureKey['.read'], /users\/' \+ auth\.uid \+ '\/driverId/);
  assert.match(packs.$departureKey['.read'], /app_sessions\/' \+ auth\.uid \+ '\/driverId/);
  assert.match(packs.$departureKey['.read'], /drivers\/' \+ root\.child\('app_sessions\/' \+ auth\.uid \+ '\/driverId'\)\.val\(\) \+ '\/authUid/);
  assert.match(packs.$departureKey['.read'], /tour_manifests\/' \+ data\.child\('tourId'\)\.val\(\) \+ '\/assigned_drivers/);
  assertClosedRule(packs.$departureKey['.write']);
  ['driver_tour_pack_tombstones', 'driver_tour_pack_ingestion'].forEach((root) => {
    assertClosedRule(rules[root]['.read']);
    assertClosedRule(rules[root]['.write']);
  });
});

test('Gate 6 action state is closed, bounded and exact-driver scoped', () => {
  const actions = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'database.rules.json'), 'utf8')).rules.driver_tour_pack_actions;
  assertClosedRule(actions['.read']);
  assertClosedRule(actions['.write']);
  const action = actions.$departureKey.$driverId;
  assertClosedRule(action['.write']);
  assert.match(action.schemaVersion['.write'], /root\.child\('users\/' \+ auth\.uid \+ '\/driverId'\)\.val\(\) === \$driverId/);
  assert.match(action.schemaVersion['.write'], /drivers\/' \+ \$driverId \+ '\/authUid/);
  assert.match(action.schemaVersion['.write'], /tour_manifests/);
  assertCurrentDriverAuthority(action.schemaVersion['.write']);
  assert.match(action.schemaVersion['.write'], /driver_tour_pack_feature_flags\/global/);
  assert.match(action.schemaVersion['.write'], /driver_tour_pack_feature_flags\/drivers\//);
  assert.doesNotMatch(action.schemaVersion['.write'], /driver_tour_pack_feature_flags\/testflight/);
  const assertEveryMutationGated = node => {
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object') assertEveryMutationGated(value);
      else if (key === '.write' && typeof value === 'string' && value.includes('app_sessions')) {
        assert.match(value, /driver_tour_pack_feature_flags\/global/);
        assert.match(value, /driver_tour_pack_feature_flags\/drivers\//);
      }
    }
  };
  assertEveryMutationGated(action);
  assertClosedRule(action.issues['.write']);
  assertClosedRule(action.pickupStops.$pickupId['.write']);
});

test('the ingestion export is private to the exact management runtime service account', () => {
  const compositionSource = fs.readFileSync(
    path.join(repositoryRoot, 'functions', 'src', 'compositionRoot.js'),
    'utf8',
  );
  const source = fs.readFileSync(
    path.join(repositoryRoot, 'functions', 'src', 'domains', 'driver-tour-packs', 'ingestionFunction.js'),
    'utf8',
  );
  assert.match(compositionSource, /ingestDriverTourPacks:\s*driverTourPacks\.ingestDriverTourPacks/);
  assert.match(source, /const ingestDriverTourPacks\s*=\s*onRequest/);
  assert.match(source, /invoker:\s*\[DEFAULT_MANAGEMENT_SYNC_SERVICE_ACCOUNT\]/);
  assert.match(source, /cors:\s*false/);
  assert.doesNotMatch(source, /ingestDriverTourPacks[\s\S]{0,500}invoker:\s*["']public["']/);
});

test('the publisher code can write only pack, tombstone, ingestion and PII-free admin-status roots', () => {
  const publisherSource = fs.readFileSync(
    path.join(repositoryRoot, 'functions', 'lib', 'driverTourPackPublisher.js'),
    'utf8',
  );
  const validationSource = fs.readFileSync(
    path.join(repositoryRoot, 'functions', 'lib', 'driverTourPackPublisherValidation.js'),
    'utf8',
  );
  assert.match(publisherSource, /assertWriteRoots\(updates\)/);
  assert.match(validationSource, /adminStatus:\s*'driver_tour_pack_admin_status'/);
  assert.match(validationSource, /new Set\(Object\.values\(DRIVER_TOUR_PACK_ROOTS\)\)/);
  assert.doesNotMatch(
    `${publisherSource}\n${validationSource}`,
    /(?:bookings|tour_manifests|booking_identities)\//,
  );
});

test('the rollout flag denies listing and permits only exact coherent-driver canary reads', () => {
  const rules = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'database.rules.json'), 'utf8')).rules;
  const flags = rules.driver_tour_pack_feature_flags;
  assertClosedRule(flags['.read']);
  assertClosedRule(flags['.write']);
  assertClosedRule(flags.drivers['.read']);
  assertCurrentDriverAuthority(flags.drivers.$driverId['.read']);
  assert.match(flags.drivers.$driverId['.read'], /users\/.*driverId/);
  assert.match(flags.drivers.$driverId['.read'], /drivers\/.*authUid/);
  assert.match(flags.drivers.$driverId['.write'], /admin_users/);
  assert.match(flags.global['.write'], /admin_users/);
  assert.match(flags.global['.validate'], /isBoolean/);
  assert.match(flags.testflight['.write'], /admin_users/);
  assert.match(flags.testflight['.validate'], /isBoolean/);
});

test('expiry cleanup is bounded and only removes driver pack lifecycle roots', () => {
  const source = fs.readFileSync(
    path.join(repositoryRoot, 'functions', 'lib', 'driverTourPackExpiryCleanup.js'),
    'utf8',
  );
  assert.match(source, /maxPacksPerRun:\s*50/);
  assert.match(source, /orderByChild\('expiresAtMs'\)/);
  assert.match(source, /driver_tour_pack_actions/);
  assert.match(source, /driver_tour_pack_tombstones/);
  assert.doesNotMatch(source, /(?:bookings|tour_manifests|booking_identities)\//);
});
