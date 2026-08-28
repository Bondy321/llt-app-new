'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fixtures = require('../../contracts/fixtures/contracts.v1.json');
const definitions = require('../../contracts/definitions/contracts.v1.json');
const generated = require('../../functions/src/contracts/generated/contracts');

const REQUIRED_METADATA = [
  'schemaVersion',
  'requiredProperties',
  'optionalProperties',
  'enumValues',
  'idPatterns',
  'maximumLengths',
  'numericBounds',
  'nullability',
  'rejectUnknownProperties',
  'safeClientProjection',
  'forbiddenClientProjection',
];

test('every canonical contract defines the required architecture metadata', () => {
  assert.equal(definitions.schemaSetVersion, 1);
  assert.ok(Object.keys(definitions.contracts).length >= 18);
  for (const [name, contract] of Object.entries(definitions.contracts)) {
    for (const field of REQUIRED_METADATA) assert.ok(Object.hasOwn(contract, field), `${name}.${field}`);
    assert.equal(contract.rejectUnknownProperties, true, name);
  }
});

test('all shared valid fixtures are accepted by the generated Functions adapter', () => {
  for (const fixture of fixtures.valid) {
    const result = generated.validateContract(fixture.contract, fixture.value, {
      clientProjection: fixture.clientProjection !== false,
    });
    assert.equal(result.valid, true, `${fixture.name}: ${result.errors.join(', ')}`);
  }
});

test('driver live-source identifiers accept exact canonical bounds and reject one character over', () => {
  const fixture = fixtures.valid.find(({ contract }) => contract === 'DriverLocationSourceRecord').value;
  const boundary = {
    ...fixture,
    authUid: 'a'.repeat(128),
    driverId: 'D'.repeat(100),
    tourId: 'T'.repeat(100),
  };
  assert.equal(generated.validateContract('DriverLocationSourceRecord', boundary).valid, true);
  for (const [property, value] of [
    ['authUid', 'a'.repeat(129)],
    ['driverId', 'D'.repeat(101)],
    ['tourId', 'T'.repeat(101)],
  ]) {
    const result = generated.validateContract('DriverLocationSourceRecord', { ...boundary, [property]: value });
    assert.equal(result.valid, false, property);
  }
});

test('credential, identity, session, media, bounds, route, and version fixtures fail closed', () => {
  for (const fixture of fixtures.invalid) {
    const result = generated.validateContract(fixture.contract, fixture.value, { clientProjection: true });
    assert.equal(result.valid, false, fixture.name);
    assert.ok(result.errors.length > 0, fixture.name);
  }
});

test('generated adapters expose identical canonical definitions in every runtime', async () => {
  const mobile = await import('../../src/shared/contracts/generated/contracts.js');
  const web = await import('../../web-admin/src/shared/contracts/generated/contracts.js');
  assert.deepEqual(mobile.CONTRACTS, generated.CONTRACTS);
  assert.deepEqual(web.CONTRACTS, generated.CONTRACTS);
  assert.equal(mobile.SCHEMA_SET_VERSION, 1);
  assert.equal(web.SCHEMA_SET_VERSION, 1);
});
