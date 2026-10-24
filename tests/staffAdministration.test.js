'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
let verified = null;
let allowlisted = false;
const originalLoad = Module._load;
Module._load = function mocked(request, parent, isMain) {
  if (!parent?.filename.endsWith('staffEnrolmentFunctions.js')) return originalLoad(request, parent, isMain);
  if (request === 'firebase-functions/v2/https') return { onRequest: (_options, handler) => handler };
  if (request.endsWith('/bootstrap/firebaseAdmin')) return { admin: {} };
  if (request.endsWith('/auth/requestAuth')) return { verifyRequestAuthUid: async () => verified };
  if (request.endsWith('/administration/public')) return { verifyOperationsAdminAccess: async () => allowlisted };
  return originalLoad(request, parent, isMain);
};
const { authorizeStaffAdministration } = require('../functions/src/domains/driver-auth/staffEnrolmentFunctions');
Module._load = originalLoad;

test('staff administration requires an allowlisted administrator with recent verified TOTP', async () => {
  const nowMs = 1_800_000_000_000;
  const check = () => authorizeStaffAdministration({ req: { body: { admin: true, mfa: true } }, db: {}, nowMs });
  verified = { success: false }; allowlisted = false;
  assert.equal((await check()).reason, 'NOT_AUTHENTICATED');
  verified = { success: true, uid: 'staff-admin', claims: { auth_time: nowMs / 1000, firebase: { sign_in_second_factor: 'totp' } } };
  assert.equal((await check()).reason, 'NOT_AUTHORIZED');
  allowlisted = true;
  assert.equal((await check()).allowed, true);
  for (const claims of [{}, { auth_time: nowMs / 1000 },
    { auth_time: nowMs / 1000, firebase: { sign_in_second_factor: 'phone' } },
    { auth_time: nowMs / 1000 + 1, firebase: { sign_in_second_factor: 'totp' } },
    { auth_time: nowMs / 1000 - 601, firebase: { sign_in_second_factor: 'totp' } }]) {
    verified = { success: true, uid: 'staff-admin', claims };
    assert.equal((await check()).reason, 'RECENT_MFA_REQUIRED');
  }
});
