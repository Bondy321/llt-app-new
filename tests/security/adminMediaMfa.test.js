'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyCurrentTourPhotoAccess } = require('../../functions/src/domains/media/mediaAccess');
const db = { ref: path => ({ once: async () => ({ exists: () => path === 'tours/TOUR', val: () => path === 'admin_users/operator' ? true : null }) }) };
test('allowlisted media administration requires verified TOTP claims', async () => {
  for (const claims of [undefined, {}, { firebase: { sign_in_second_factor: 'phone' } }]) {
    assert.equal((await verifyCurrentTourPhotoAccess({ db, authUid: 'operator', tourId: 'TOUR', claims })).allowed, false);
  }
  assert.equal((await verifyCurrentTourPhotoAccess({ db, authUid: 'operator', tourId: 'TOUR',
    claims: { firebase: { sign_in_second_factor: 'totp' } } })).allowed, true);
});
test('the primary administrator also requires TOTP for group media', async () => {
  assert.equal((await verifyCurrentTourPhotoAccess({ db, authUid: '9CWQ4705gVRkfW5Xki5LyvrmVp23', tourId: 'TOUR' })).allowed, false);
});
