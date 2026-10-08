import test from 'node:test';
import assert from 'node:assert/strict';
import { createDriverTrackingController } from '../services/driver-tracking/createDriverTrackingController.js';
import { TRACKING_STORAGE_KEY, latestTrackingSample, validateTrackingIntent } from '../services/driver-tracking/trackingIntent.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const until = async predicate => { for (let i = 0; i < 100; i += 1) { if (predicate()) return; await new Promise(setImmediate); } throw new Error('Test phase not reached'); };
const harness = (storageMap = new Map()) => {
  const events = [];
  const control = { time: 1_800_000_000_000, foreground: true, registered: false, permitted: true,
    authority: async () => ({ valid: true }), permissions: async () => {},
    nativeStart: async () => {}, fence: async () => {}, retire: async () => ({ withdrawalAcknowledged: true }),
    publish: async () => ({ timestamp: control.time, publicationAcknowledged: true }),
    read: async () => storageMap.get(TRACKING_STORAGE_KEY) || null, save: async value => storageMap.set(TRACKING_STORAGE_KEY, value) };
  const scope = { role: 'driver', authUid: 'test-driver', cacheOwnerId: 'D-TEST', principalId: 'driver:D-TEST',
    tourId: 'TOUR_TEST', sessionId: `sess_v1_${'a'.repeat(32)}`, expiresAtMs: control.time + 3_600_000 };
  let counter = 0;
  const tracking = createDriverTrackingController({ now: () => control.time, makeId: () => `track_session_${++counter}`,
    storage: { getItem: () => control.read(), setItem: (_key, value) => control.save(value),
      removeItem: async () => { events.push('clear'); storageMap.delete(TRACKING_STORAGE_KEY); } },
    native: { isForeground: () => control.foreground, isStarted: async () => control.registered,
      hasPermissions: async () => control.permitted, requestPermissions: () => control.permissions(),
      start: async () => { events.push('native_start'); await control.nativeStart(); control.registered = true; },
      stop: async () => { events.push('native_stop'); control.registered = false; }, permissionMessage: error => error.message },
    verifyAuthority: value => control.authority(value),
    writeFence: async (value, status) => { events.push(`fence_${status}`); return control.fence(value, status); },
    retireSession: async value => { events.push('retire'); return control.retire(value); },
    publish: async (...args) => { events.push('publish'); return control.publish(...args); },
  });
  const start = () => tracking.start({ scope, disclosureAccepted: true });
  const sample = (timestamp = control.time, latitude = 56.1) => ({ timestamp, coords: { latitude, longitude: -4.2, accuracy: 12 } });
  const stored = () => JSON.parse(storageMap.get(TRACKING_STORAGE_KEY));
  return { tracking, control, events, scope, start, sample, stored, storageMap };
};

test('only explicit disclosed, foreground driver Start can enable tracking; passive recovery never starts', async () => {
  const h = harness();
  await h.tracking.setScope(h.scope);
  await h.tracking.recover();
  assert.equal((await h.tracking.start({ scope: h.scope })).reason, 'DISCLOSURE_REQUIRED');
  assert.equal((await h.tracking.start({ scope: { ...h.scope, role: 'passenger' }, disclosureAccepted: true })).reason, 'DRIVER_SESSION_REQUIRED');
  h.control.foreground = false;
  assert.equal((await h.start()).success, false);
  assert.equal(h.events.includes('native_start'), false);
  h.control.foreground = true;
  assert.equal((await h.start()).success, true);
  assert.deepEqual(h.events, ['fence_active', 'native_start']);
  assert.equal(h.stored().status, 'active');
  assert.equal(h.tracking.getSnapshot().active, true);
});

test('permission rejection and remote authority loss never create tracking intent', async () => {
  const h = harness(); h.control.permissions = async () => { throw new Error('PERMISSION_REQUIRED'); };
  assert.equal((await h.start()).success, false);
  assert.equal(h.storageMap.size, 0);
  h.control.permissions = async () => {};
  h.control.authority = async () => ({ valid: false, reason: 'SESSION_CHANGED' });
  assert.equal((await h.start()).reason, 'SESSION_CHANGED');
  assert.equal(h.events.length, 0);
});

test('stop fences immediately during a permission prompt; late approval cannot restart it or disturb a newer Start', async () => {
  const h = harness(); const permission = deferred();
  h.control.permissions = () => permission.promise;
  const oldStart = h.start();
  await h.tracking.stop();
  h.control.permissions = async () => {};
  assert.equal((await h.start()).success, true);
  const newIdentity = h.stored().liveSharingSessionId;
  permission.resolve();
  assert.equal((await oldStart).reason, 'START_INTERRUPTED');
  assert.equal(h.tracking.getSnapshot().active, true);
  assert.equal(h.stored().liveSharingSessionId, newIdentity);
});

test('Stop during native registration cleans up the exact intent after the pending start resolves', async () => {
  const h = harness(); const pending = deferred(); h.control.nativeStart = () => pending.promise;
  const starting = h.start(); await until(() => h.events.includes('native_start'));
  const stopped = h.tracking.stop();
  assert.equal(h.tracking.getSnapshot().active, false);
  await until(() => h.stored().status === 'stopping');
  pending.resolve();
  assert.equal((await starting).reason, 'START_INTERRUPTED');
  assert.equal((await stopped).withdrawalAcknowledged, true);
  assert.equal(h.control.registered, false);
  assert.equal(h.storageMap.size, 0);
});

test('ambiguous active fence failure compensates without starting native updates', async () => {
  const h = harness(); h.control.fence = async () => { throw new Error('NETWORK_ERROR'); };
  assert.equal((await h.start()).success, false);
  assert.deepEqual(h.events, ['fence_active', 'native_stop', 'retire', 'clear']);
  assert.equal(h.storageMap.size, 0);
});

test('Stop orders durable writes behind a delayed active save and prevents subsequent fence/native activation', async () => {
  const h = harness(); const pending = deferred(); let saving = false;
  h.control.save = async value => {
    if (JSON.parse(value).status === 'active') { saving = true; await pending.promise; }
    h.storageMap.set(TRACKING_STORAGE_KEY, value);
  };
  const starting = h.start(); await until(() => saving);
  const stopping = h.tracking.stop();
  pending.resolve();
  assert.equal((await starting).reason, 'START_INTERRUPTED');
  assert.equal((await stopping).success, true);
  assert.equal(h.events.includes('fence_active'), false);
  assert.equal(h.events.includes('native_start'), false);
  assert.equal(h.storageMap.size, 0);
});

test('failed cleanup retains a stopped identity across restart and blocks Start until acknowledged', async () => {
  const h = harness(); await h.start(); const identity = h.stored().liveSharingSessionId;
  h.control.retire = async () => { throw new Error('OFFLINE'); };
  assert.equal((await h.tracking.stop()).success, false);
  assert.equal(h.stored().status, 'stopping');
  assert.equal(h.tracking.getSnapshot().pending, true);
  assert.equal((await h.start()).reason, 'TRACKING_BUSY');
  const restarted = harness(h.storageMap);
  restarted.control.retire = async value => { assert.equal(value.liveSharingSessionId, identity); return { withdrawalAcknowledged: true }; };
  await restarted.tracking.recover();
  assert.equal(restarted.storageMap.size, 0);
  assert.equal(restarted.events.includes('native_start'), false);
  assert.equal((await restarted.start()).success, true);
});

test('cold UI launch retires an interrupted active session once and requires another manual Start', async () => {
  const h = harness(); await h.start(); const restarted = harness(h.storageMap);
  restarted.control.registered = true;
  const first = restarted.tracking.recover();
  assert.strictEqual(first, restarted.tracking.recover());
  await first;
  assert.match(restarted.tracking.getSnapshot().status, /interrupted/);
  assert.equal(restarted.control.registered, false);
  assert.equal(restarted.events.filter(event => event === 'retire').length, 1);
});

test('headless delivery restores only explicit active intent and never starts the native service', async () => {
  const h = harness(); await h.start();
  const background = harness(h.storageMap);
  await background.tracking.handleLocations({ locations: [background.sample()] });
  assert.equal(background.events.filter(event => event === 'publish').length, 1);
  assert.equal(background.events.includes('native_start'), false);
  assert.equal(background.tracking.getSnapshot().state, 'sharing');
  assert.doesNotMatch(h.storageMap.get(TRACKING_STORAGE_KEY), /latitude|longitude|coords/);
  const noIntent = harness();
  await noIntent.tracking.handleLocations({ locations: [noIntent.sample()] });
  assert.equal(noIntent.events.includes('publish'), false);
});

test('freshest valid sample wins; pre-session, stale, future, invalid and inaccurate coordinates are excluded', async () => {
  const h = harness(); await h.start(); h.control.time += 200_000;
  const candidate = h.stored();
  const latest = h.sample(h.control.time, 56.2);
  assert.strictEqual(latestTrackingSample([h.sample(candidate.startedAtMs - 1), h.sample(h.control.time - 100_000),
    h.sample(h.control.time + 6000), { ...latest, coords: { latitude: '56', longitude: -4, accuracy: 10 } },
    { ...latest, coords: { latitude: 56, longitude: -4, accuracy: 10001 } }, latest], candidate, h.control.time), latest);
  assert.equal(validateTrackingIntent({ ...candidate, liveSharingSessionId: 'loc_old' }), null);
  assert.equal(validateTrackingIntent({ ...candidate, scope: { ...candidate.scope, principalId: 'passenger:wrong' } }), null);
});

test('offline updates are skipped without queuing positions and sharing resumes only with a fresh delivery', async () => {
  const h = harness(); await h.start(); h.control.authority = async () => ({ valid: false, reason: 'OFFLINE' });
  await h.tracking.handleLocations({ locations: [h.sample()] });
  assert.equal(h.tracking.getSnapshot().state, 'paused');
  assert.equal(h.events.includes('publish'), false);
  h.control.time += 100_000; h.control.authority = async () => ({ valid: true });
  await h.tracking.handleLocations({ locations: [h.sample(h.control.time - 100_000)] });
  assert.equal(h.events.includes('publish'), false);
  await h.tracking.handleLocations({ locations: [h.sample()] });
  assert.equal(h.events.filter(event => event === 'publish').length, 1);
});

test('concurrent native deliveries coalesce; Stop during publication revokes its scope guard', async () => {
  const h = harness(); await h.start(); const pending = deferred(); let guard;
  h.control.publish = async (_intent, _sample, current) => { guard = current; return pending.promise; };
  const first = h.tracking.handleLocations({ locations: [h.sample()] });
  await until(() => Boolean(guard));
  const second = h.tracking.handleLocations({ locations: [h.sample()] });
  const stopped = h.tracking.stop(); assert.equal(guard(), false);
  pending.resolve({ timestamp: h.control.time });
  await Promise.all([first, second, stopped]);
  assert.equal(h.events.filter(event => event === 'publish').length, 1);
  assert.equal(h.tracking.getSnapshot().active, false);
});

test('frequent foreground iOS fixes are throttled independently of native delivery; fresh updates resume each minute', async () => {
  const h = harness(); await h.start();
  await h.tracking.handleLocations({ locations: [h.sample()] });
  for (let i = 0; i < 20; i += 1) {
    h.control.time += 1000;
    await h.tracking.handleLocations({ locations: [h.sample()] });
  }
  assert.equal(h.events.filter(event => event === 'publish').length, 1);
  h.control.time += 40000;
  await h.tracking.handleLocations({ locations: [h.sample()] });
  assert.equal(h.events.filter(event => event === 'publish').length, 2);
  h.control.time += 100000; await h.tracking.checkCurrent();
  assert.equal(h.tracking.getSnapshot().state, 'waiting');
  assert.match(h.tracking.getSnapshot().status, /no recent GPS update/);
});

for (const reason of ['OFFLINE', 'SESSION_CHANGED']) {
  test(`late ${reason} authority result from retired A cannot change or stop B`, async () => {
    const h = harness(); await h.start(); const pending = deferred(); let waiting = false;
    h.control.authority = () => { waiting = true; return pending.promise; };
    const delivery = h.tracking.handleLocations({ locations: [h.sample()] });
    await until(() => waiting); await h.tracking.stop();
    h.control.authority = async () => ({ valid: true }); await h.start();
    const identity = h.stored().liveSharingSessionId;
    pending.resolve({ valid: false, reason }); await delivery;
    assert.equal(h.tracking.getSnapshot().active, true);
    assert.equal(h.stored().liveSharingSessionId, identity);
    assert.equal(h.events.filter(event => event === 'retire').length, 1);
  });
}

test('late initial storage read cannot restore A or stop B', async () => {
  const h = harness(); await h.start(); const old = h.storageMap.get(TRACKING_STORAGE_KEY);
  const pending = deferred(); h.control.read = () => pending.promise;
  const delivery = h.tracking.handleLocations({ locations: [h.sample()] });
  h.control.read = async () => h.storageMap.get(TRACKING_STORAGE_KEY) || null;
  await h.tracking.stop(); await h.start();
  const identity = h.stored().liveSharingSessionId;
  pending.resolve(old); await delivery;
  assert.equal(h.tracking.getSnapshot().active, true);
  assert.equal(h.stored().liveSharingSessionId, identity);
});

test('late permission-denied publication cannot stop a replacement session', async () => {
  const h = harness(); await h.start(); const pending = deferred();
  h.control.publish = () => pending.promise;
  const delivery = h.tracking.handleLocations({ locations: [h.sample()] });
  await until(() => h.events.includes('publish'));
  await h.tracking.stop(); await h.start();
  pending.reject(Object.assign(new Error('PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' }));
  await delivery; assert.equal(h.tracking.getSnapshot().active, true);
});

test('late rejected authority operation cannot stop a replacement session', async () => {
  const h = harness(); await h.start(); const pending = deferred(); let waiting = false;
  h.control.authority = () => { waiting = true; return pending.promise; };
  const delivery = h.tracking.handleLocations({ locations: [h.sample()] });
  await until(() => waiting); await h.tracking.stop();
  h.control.authority = async () => ({ valid: true }); await h.start();
  pending.reject(Error('STORAGE_TEMPORARILY_UNAVAILABLE')); await delivery;
  assert.equal(h.tracking.getSnapshot().active, true);
});

test('unattributed native task errors pause a permitted session; confirmed permission loss stops it', async () => {
  const h = harness(); await h.start();
  await h.tracking.handleLocations({ error: { message: 'late_native_provider_error' } });
  assert.equal(h.tracking.getSnapshot().active, true); assert.equal(h.tracking.getSnapshot().state, 'paused');
  h.control.permitted = false;
  await h.tracking.handleLocations({ error: { message: 'location_access_denied' } });
  assert.equal(h.tracking.getSnapshot().active, false);
});

test('reassignment, logout, permission revocation, missing native registration and expiry stop tracking', async () => {
  for (const kind of ['assignment', 'logout', 'permission', 'native', 'expiry']) {
    const h = harness(); await h.tracking.setScope(h.scope); await h.start();
    if (kind === 'assignment') await h.tracking.setScope({ ...h.scope, tourId: 'TOUR_OTHER' });
    else if (kind === 'logout') await h.tracking.setScope(null);
    else {
      if (kind === 'permission') h.control.permitted = false;
      if (kind === 'native') h.control.registered = false;
      if (kind === 'expiry') h.control.time = h.scope.expiresAtMs;
      await h.tracking.checkCurrent();
    }
    assert.equal(h.tracking.getSnapshot().active, false, kind);
    assert.equal(h.storageMap.size, 0, kind);
  }
});

test('late native health check from A cannot stop B', async () => {
  const h = harness(); await h.start(); const pending = deferred();
  // A permission result can be delayed while native registration is still true.
  h.control.permitted = pending.promise;
  const health = h.tracking.checkCurrent(); await new Promise(setImmediate);
  await h.tracking.stop(); h.control.permitted = true; await h.start();
  pending.resolve(false); await health;
  assert.equal(h.tracking.getSnapshot().active, true);
});

test('failed durable stop save retains pending status even when server cleanup acknowledged', async () => {
  const h = harness(); await h.start();
  h.control.save = async () => { throw new Error('DISK_FAILURE'); };
  await h.tracking.stop(); assert.equal(h.tracking.getSnapshot().pending, true);
  assert.equal(h.events.includes('retire'), true);
  h.control.save = async value => h.storageMap.set(TRACKING_STORAGE_KEY, value);
  await h.tracking.checkCurrent(); assert.equal(h.tracking.getSnapshot().pending, false);
});

test('session privacy purge stops native tracking and clears only the captured driver identity despite offline cleanup', async () => {
  const h = harness(); await h.start();
  h.control.retire = async () => { throw Error('OFFLINE'); };
  assert.equal((await h.tracking.purgeScope({ authUid: 'another-user', sessionId: h.scope.sessionId })).skipped, true);
  assert.equal(h.tracking.getSnapshot().active, true);
  await h.tracking.purgeScope({ authUid: h.scope.authUid, sessionId: h.scope.sessionId });
  assert.equal(h.control.registered, false); assert.equal(h.storageMap.size, 0);
  assert.equal(h.tracking.getSnapshot().pending, false);
  await h.tracking.setScope({ ...h.scope, authUid: 'replacement-auth' });
  assert.equal((await h.tracking.start({ scope: { ...h.scope, authUid: 'replacement-auth' }, disclosureAccepted: true })).success, true);
});
