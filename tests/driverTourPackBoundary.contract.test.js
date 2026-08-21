const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');

test('Gate 6 opens only exact coherent-driver pack reads and keeps server roots private', () => {
  const rules = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'database.rules.json'), 'utf8')).rules;
  const packs = rules.driver_tour_packs;
  assert.equal(packs['.read'], false);
  assert.equal(packs['.write'], false);
  assert.ok(packs['.indexOn'].includes('expiresAtMs'));
  assert.match(packs.$departureKey['.read'], /users\/' \+ auth\.uid \+ '\/driverId/);
  assert.match(packs.$departureKey['.read'], /drivers\/' \+ root\.child\('users\/' \+ auth\.uid \+ '\/driverId'\)\.val\(\) \+ '\/authUid/);
  assert.match(packs.$departureKey['.read'], /tour_manifests\/' \+ data\.child\('tourId'\)\.val\(\) \+ '\/assigned_drivers/);
  assert.equal(packs.$departureKey['.write'], false);
  ['driver_tour_pack_tombstones', 'driver_tour_pack_ingestion'].forEach((root) => {
    assert.deepEqual(rules[root], { '.read': false, '.write': false });
  });
});

test('Gate 6 action state is closed, bounded and exact-driver scoped', () => {
  const actions = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'database.rules.json'), 'utf8')).rules.driver_tour_pack_actions;
  assert.equal(actions['.read'], false);
  assert.equal(actions['.write'], false);
  const action = actions.$departureKey.$driverId;
  assert.equal(action['.write'], false);
  assert.match(action.schemaVersion['.write'], /root\.child\('users\/' \+ auth\.uid \+ '\/driverId'\)\.val\(\) === \$driverId/);
  assert.match(action.schemaVersion['.write'], /drivers\/' \+ \$driverId \+ '\/authUid/);
  assert.match(action.schemaVersion['.write'], /tour_manifests/);
  assert.equal(action.issues['.write'], false);
  assert.equal(action.pickupStops.$pickupId['.write'], false);
});

test('the ingestion export is private to the exact management runtime service account', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'functions', 'index.js'), 'utf8');
  assert.match(source, /exports\.ingestDriverTourPacks\s*=\s*onRequest/);
  assert.match(source, /invoker:\s*\[DEFAULT_MANAGEMENT_SYNC_SERVICE_ACCOUNT\]/);
  assert.match(source, /cors:\s*false/);
  assert.doesNotMatch(source, /ingestDriverTourPacks[\s\S]{0,500}invoker:\s*["']public["']/);
});

test('the publisher code can write only pack, tombstone, ingestion and PII-free admin-status roots', () => {
  const source = fs.readFileSync(
    path.join(repositoryRoot, 'functions', 'lib', 'driverTourPackPublisher.js'),
    'utf8',
  );
  assert.match(source, /assertWriteRoots\(updates\)/);
  assert.match(source, /adminStatus:\s*'driver_tour_pack_admin_status'/);
  assert.doesNotMatch(source, /(?:bookings|tour_manifests|booking_identities)\//);
});

test('the rollout flag denies listing and permits only exact coherent-driver canary reads', () => {
  const rules = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'database.rules.json'), 'utf8')).rules;
  const flags = rules.driver_tour_pack_feature_flags;
  assert.equal(flags['.read'], false);
  assert.equal(flags['.write'], false);
  assert.equal(flags.drivers['.read'], false);
  assert.match(flags.drivers.$driverId['.read'], /users\/.*driverId/);
  assert.match(flags.drivers.$driverId['.read'], /drivers\/.*authUid/);
  assert.match(flags.drivers.$driverId['.write'], /admin_users/);
  assert.match(flags.global['.write'], /admin_users/);
  assert.match(flags.global['.validate'], /isBoolean/);
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
