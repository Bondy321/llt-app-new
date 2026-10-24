'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyHttpAppCheck } = require('../../functions/src/infrastructure/auth/httpAppCheck');

test('serving HTTP handlers require valid attestation even with obsolete false flag', async () => {
  const options = { env: { K_SERVICE: 'test-service', REQUIRE_APP_CHECK_FOR_HTTP: 'false' }, appCheck: () => ({ verifyToken: async token => { if (token !== 'synthetic-valid') throw new Error('invalid'); } }) };
  assert.equal(await verifyHttpAppCheck({ headers: {} }, options), false);
  assert.equal(await verifyHttpAppCheck({ headers: { 'x-firebase-appcheck': 'invalid' } }, options), false);
  assert.equal(await verifyHttpAppCheck({ headers: { 'x-firebase-appcheck': 'synthetic-valid' } }, options), true);
});

test('isolated local handler does not contact an App Check provider', async () => {
  assert.equal(await verifyHttpAppCheck({ headers: {} }, { env: {}, appCheck: () => { throw new Error('External provider forbidden'); } }), true);
});
