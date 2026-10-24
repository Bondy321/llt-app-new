'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readBoundedShallowKeys, buildShallowUrl } = require('../functions/src/infrastructure/database/shallowKeys');
const db = { app: { options: { databaseURL: 'https://demo-bounded-default-rtdb.firebaseio.com',
  credential: { getAccessToken: async () => ({ access_token: 'synthetic-secret' }) } } } };

test('shallow reads preserve exact namespace and keep OAuth token out of URL', async () => {
  const keys = await readBoundedShallowKeys({ db, path: 'private_tour_photos/TOUR', env: {},
    fetchImpl: async (url, options) => {
      assert.equal(url.origin, 'https://demo-bounded-default-rtdb.firebaseio.com');
      assert.equal(url.search, '?shallow=true'); assert.equal(options.headers.Authorization, 'Bearer synthetic-secret');
      assert.equal(options.redirect, 'error'); return new Response(JSON.stringify({ b: true, a: true }));
    } });
  assert.deepEqual(keys, ['a', 'b']);
  const local = buildShallowUrl({ databaseURL: db.app.options.databaseURL, path: 'private_tour_photos/TOUR', emulatorHost: '127.0.0.1:9000' });
  assert.equal(local.searchParams.get('ns'), 'demo-bounded-default-rtdb');
  assert.equal(local.origin, 'http://127.0.0.1:9000');
  assert.throws(() => buildShallowUrl({ databaseURL: 'https://evil.example', path: 'photos' }));
  assert.throws(() => buildShallowUrl({ databaseURL: db.app.options.databaseURL, path: 'photos', emulatorHost: 'remote.example:9000' }));
});

test('shallow owner lookup fails closed on oversized bytes, too many keys, nested data and timeout', async () => {
  for (const options of [
    { maxBytes: 4, fetchImpl: async () => new Response('{"owner":true}') },
    { maxKeys: 1, fetchImpl: async () => new Response('{"a":true,"b":true}') },
    { fetchImpl: async () => new Response('{"owner":{"photo":"private"}}') },
    { timeoutMs: 5, fetchImpl: () => new Promise(() => {}) },
  ]) await assert.rejects(readBoundedShallowKeys({ db, path: 'private_tour_photos/TOUR', env: {}, ...options }),
    error => error.code === 'DATABASE_KEYS_UNAVAILABLE');
});
