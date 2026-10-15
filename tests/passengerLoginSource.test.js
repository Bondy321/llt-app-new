'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');

process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: 'demo-passenger-login-source' });
const { buildPassengerSessionRecord } = require('../functions/lib/appSession');
const { buildAppSessionCleanupUpdates } = require('../functions/lib/appSessionCleanup');
const { retireRejectedPassengerSession } = require('../functions/src/domains/app-sessions/rejectedPassengerSession');
const sourceChecks = require('../functions/src/domains/passenger-auth/passengerLoginSource');
const issuance = require('../functions/src/domains/app-sessions/sessionIssuance');
const AUTH_UID = 'synthetic-login-device';
const PRINCIPAL = `pax_v2_${'a'.repeat(32)}`;
const BOOKING = 'SYNTH123';
const get = (state, key) => key.split('/').filter(Boolean).reduce((value, part) => value?.[part], state);
const set = (state, key, value) => {
  const parts = key.split('/').filter(Boolean);
  const leaf = parts.pop();
  let current = state;
  for (const part of parts) current = current[part] ||= {};
  if (value === null) delete current[leaf]; else current[leaf] = structuredClone(value);
};
const snapshot = (value) => ({ exists: () => value !== undefined && value !== null,
  val: () => value === undefined ? null : structuredClone(value) });
const database = (state) => ({ ref(key = '') { return {
  once: async () => snapshot(get(state, key)),
  transaction: async (change) => {
    const previous = get(state, key) ?? null;
    const next = change(structuredClone(previous));
    if (next === undefined) return { committed: false, snapshot: snapshot(previous) };
    set(state, key, next);
    return { committed: true, snapshot: snapshot(next) };
  },
  update: async (updates) => Object.entries(updates).forEach(([child, value]) => set(state, key ? `${key}/${child}` : child, value)),
}; } });
const baseState = () => ({
  booking_identities: { [BOOKING]: { bookingRef: BOOKING, email: 'synthetic@example.test', tourId: 'TOUR_A' } },
  bookings: { [BOOKING]: { tourId: 'TOUR_A', loginEligible: true, passengerNames: ['Synthetic Passenger'],
    passengerDetails: [{ name: 'Synthetic Passenger', seatNo: '1' }], seatNumbers: ['1'] } },
  tours: { TOUR_A: { name: 'Synthetic departure', tourCode: 'TOUR_A', isActive: true,
    startDate: '16/10/2026', endDate: '16/10/2026', rosterSync: { state: 'ready', generation: 'g1', reportDate: '2026-10-15' } } },
  passenger_identity_security: { [BOOKING]: { passengerPrincipalId: PRINCIPAL, passengerIdentityVersion: 'pax_v2', authorizedAuthUid: AUTH_UID } },
  historicalBoarding: { preserved: true },
});

const createWorkflow = ({ state = baseState(), onAcquire = () => {}, onIssue = () => {}, onClaims = () => {} } = {}) => {
  const db = database(state);
  const retirements = [];
  const issued = [];
  const fakeLock = { acquired: true, owner: 'synthetic-owner' };
  const cleanupSession = async ({ session }) => db.ref().update(buildAppSessionCleanupUpdates({ session,
    userProfile: get(state, `users/${AUTH_UID}`) || {}, nowMs: Date.now() }));
  const retireSession = async (input) => {
    retirements.push(input.session.sessionId);
    return retireRejectedPassengerSession({ ...input, cleanupSession });
  };
  const appSessions = {
    ...require('../functions/src/domains/app-sessions/public'),
    buildVerifiedLoginGrantUpdates: issuance.buildVerifiedLoginGrantUpdates,
    buildPassengerRoleClaimJob: () => ({}),
    issuePassengerAppSession: async (input) => {
      const session = buildPassengerSessionRecord(input);
      await db.ref().update({ ...input.identityUpdates, ...input.grantUpdates,
        [`app_sessions/${AUTH_UID}`]: session });
      issued.push(session);
      onIssue(state, session);
      return session;
    },
    reconcilePassengerRoleClaimJob: async () => { onClaims(state); return { completed: true }; },
  };
  const filename = path.resolve(__dirname, '../functions/src/domains/passenger-auth/passengerLoginWorkflow.js');
  const realRequire = createRequire(filename);
  const actualLegacy = realRequire('../../bootstrap/legacyLibrary');
  const mocks = {
    '../../bootstrap/firebaseAdmin': { admin: { database: () => db, auth: () => ({}) } },
    '../../bootstrap/legacyLibrary': { loadLegacyLibrary: (name) => name === 'appSessionLock'
      ? { acquireAppSessionLock: async () => {
        set(state, `app_session_locks/${AUTH_UID}`, { owner: fakeLock.owner, expiresAtMs: Date.now() + 180000 });
        onAcquire(state);
        return fakeLock;
      }, releaseAppSessionLock: async () => true }
      : actualLegacy.loadLegacyLibrary(name) },
    '../../infrastructure/auth/loginAppCheckGate': { enforceLoginAppCheck: async () => true },
    '../../infrastructure/auth/requestAuth': { verifyRequestAuthUid: async () => ({ success: true, uid: AUTH_UID }) },
    '../../infrastructure/logging/safeLogger': { log: { warn() {}, error() {}, info() {} } },
    '../app-sessions/public': appSessions,
    './passengerLoginSecurity': { checkPassengerLoginRateLimits: async () => ({ allowed: true }),
      distributedLoginRateLimiter() {}, getTrustedRequestNetworkKey: () => 'synthetic-network' },
    './passengerLoginSource': { ...sourceChecks, confirmIssuedPassengerSource: (input) =>
      sourceChecks.confirmIssuedPassengerSource({ ...input, retireSession }) },
    '../account-deletion/public': { ensureNoActiveAccountDeletion: async () => {},
      ensureNoActivePassengerAccountDeletion: async () => {},
      acquirePassengerAccountDeletionLock: async () => ({ ...fakeLock, bookingRef: BOOKING }),
      releasePassengerAccountDeletionLock: async () => true },
  };
  const module = { exports: {} };
  const localRequire = (name) => mocks[name] || realRequire(name);
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`, { filename })(localRequire, module, module.exports);
  return { state, db, retirements, issued, login: () => module.exports.executePassengerLogin({ req: { headers: {} },
    bookingRef: BOOKING, email: 'synthetic@example.test' }) };
};

test('login refreshes canonical source under its locks before selecting the session scope', async () => {
  const scenario = createWorkflow({ onAcquire(state) {
    state.booking_identities[BOOKING].tourId = 'TOUR_B';
    state.bookings[BOOKING].tourId = 'TOUR_B';
    state.tours.TOUR_B = { ...state.tours.TOUR_A, tourCode: 'TOUR_B' };
  } });
  const result = await scenario.login();
  assert.equal(result.body.valid, true);
  assert.equal(result.body.tourId, 'TOUR_B');
  assert.equal(scenario.issued.length, 1);
  assert.equal(scenario.issued[0].tourId, 'TOUR_B');
});

test('credential changes before issuance reject login without creating a session', async () => {
  const scenario = createWorkflow({ onAcquire(state) { state.booking_identities[BOOKING].email = 'changed@example.test'; } });
  const result = await scenario.login();
  assert.equal(result.body.valid, false);
  assert.equal(result.body.reason, 'INVALID_CREDENTIALS');
  assert.equal(scenario.issued.length, 0);
});

test('source changes during issuance never return a successful login and retire only the new session', async () => {
  const changes = {
    transfer(state) { state.booking_identities[BOOKING].tourId = 'TOUR_B'; state.bookings[BOOKING].tourId = 'TOUR_B';
      state.tours.TOUR_B = { ...state.tours.TOUR_A, tourCode: 'TOUR_B' }; },
    cancellation(state) { state.tours.TOUR_A.isActive = false; },
    email(state) { state.booking_identities[BOOKING].email = 'changed@example.test'; },
    eligibility(state) { state.bookings[BOOKING].loginEligible = false; },
    updating(state) { state.tours.TOUR_A.rosterSync.state = 'updating'; },
    generation(state) { state.tours.TOUR_A.rosterSync.generation = 'g2'; },
  };
  for (const [name, onIssue] of Object.entries(changes)) {
    const scenario = createWorkflow({ onIssue });
    const result = await scenario.login();
    assert.equal(result.body.valid, false, name);
    assert.equal(scenario.issued.length, 1, name);
    assert.deepEqual(scenario.retirements, [scenario.issued[0].sessionId], name);
    assert.equal(get(scenario.state, `app_sessions/${AUTH_UID}`), undefined, name);
    assert.deepEqual(scenario.state.historicalBoarding, { preserved: true }, name);
    assert.equal(scenario.state.passenger_identity_security[BOOKING].passengerPrincipalId, PRINCIPAL, name);
  }
});

test('changes while Auth claims are reconciled are included in the final source check', async () => {
  const scenario = createWorkflow({ onClaims(state) { state.tours.TOUR_A.rosterSync.generation = 'g2'; } });
  const result = await scenario.login();
  assert.equal(result.body.valid, false);
  assert.equal(result.body.reason, 'SOURCE_CHANGED');
  assert.equal(scenario.retirements.length, 1);
});

test('mismatched canonical booking tour is rejected before issuance', async () => {
  const state = baseState();
  state.bookings[BOOKING].tourId = 'TOUR_B';
  const scenario = createWorkflow({ state });
  const result = await scenario.login();
  assert.equal(result.body.valid, false);
  assert.equal(scenario.issued.length, 0);
});

test('cleanup failure invalidates only the rejected session and preserves a replacement login', async () => {
  for (const replace of [false, true]) {
    const state = baseState();
    const db = database(state);
    const session = buildPassengerSessionRecord({ authUid: AUTH_UID, principalId: PRINCIPAL, tourId: 'TOUR_A' });
    set(state, `app_sessions/${AUTH_UID}`, session);
    const replacement = { ...session, sessionId: `sess_v1_${'f'.repeat(32)}` };
    const result = await retireRejectedPassengerSession({ db, session, appSessionLock: { acquired: true, owner: 'owner' },
      renewSessionLock: async () => true,
      cleanupSession: async () => {
        if (replace) set(state, `app_sessions/${AUTH_UID}`, replacement);
        throw new Error('Synthetic cleanup failure');
      } });
    assert.equal(result.cleanupPending, true);
    assert.equal(result.retired, !replace);
    assert.deepEqual(get(state, `app_sessions/${AUTH_UID}`), replace ? replacement : undefined);
    assert.deepEqual(state.historicalBoarding, { preserved: true });
  }
});

test('lost issuance lease never performs multi-root cleanup or revokes a replacement session', async () => {
  const state = baseState();
  const db = database(state);
  const session = buildPassengerSessionRecord({ authUid: AUTH_UID, principalId: PRINCIPAL, tourId: 'TOUR_A' });
  const replacement = { ...session, sessionId: `sess_v1_${'e'.repeat(32)}` };
  set(state, `app_sessions/${AUTH_UID}`, replacement);
  const result = await retireRejectedPassengerSession({ db, session, appSessionLock: { acquired: true, owner: 'stale' },
    renewSessionLock: async () => false, cleanupSession: async () => assert.fail('Stale owner cannot clean a replacement') });
  assert.equal(result.retired, false);
  assert.deepEqual(get(state, `app_sessions/${AUTH_UID}`), replacement);
});

test('lost issuance lease can still withdraw its own exact rejected authority safely', async () => {
  const state = baseState();
  const db = database(state);
  const session = buildPassengerSessionRecord({ authUid: AUTH_UID, principalId: PRINCIPAL, tourId: 'TOUR_A' });
  set(state, `app_sessions/${AUTH_UID}`, session);
  const other = { ...session, authUid: 'another-phone', sessionId: `sess_v1_${'c'.repeat(32)}` };
  set(state, 'app_sessions/another-phone', other);
  const result = await retireRejectedPassengerSession({ db, session, appSessionLock: { acquired: true, owner: 'stale' },
    renewSessionLock: async () => false, cleanupSession: async () => assert.fail('Stale owner cannot perform multi-root cleanup') });
  assert.deepEqual(result, { retired: true, cleanupPending: true });
  assert.equal(get(state, `app_sessions/${AUTH_UID}`), undefined);
  assert.deepEqual(get(state, 'app_sessions/another-phone'), other);
  assert.deepEqual(state.historicalBoarding, { preserved: true });
});
