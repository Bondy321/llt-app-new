const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');

test('new Driver Tour Pack roots remain private until Gate 6 rules are deployed', () => {
  const rules = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'database.rules.json'), 'utf8')).rules;
  ['driver_tour_packs', 'driver_tour_pack_tombstones', 'driver_tour_pack_ingestion'].forEach((root) => {
    assert.deepEqual(rules[root], { '.read': false, '.write': false });
  });
});

test('the ingestion export is private to the exact management runtime service account', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'functions', 'index.js'), 'utf8');
  assert.match(source, /exports\.ingestDriverTourPacks\s*=\s*onRequest/);
  assert.match(source, /invoker:\s*\[DEFAULT_MANAGEMENT_SYNC_SERVICE_ACCOUNT\]/);
  assert.match(source, /cors:\s*false/);
  assert.doesNotMatch(source, /ingestDriverTourPacks[\s\S]{0,500}invoker:\s*["']public["']/);
});

test('the publisher code can write only pack, tombstone and ingestion roots', () => {
  const source = fs.readFileSync(
    path.join(repositoryRoot, 'functions', 'lib', 'driverTourPackPublisher.js'),
    'utf8',
  );
  assert.match(source, /assertWriteRoots\(updates\)/);
  assert.doesNotMatch(source, /(?:bookings|tour_manifests|booking_identities)\//);
});
