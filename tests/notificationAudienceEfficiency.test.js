const assert = require('node:assert/strict');
const test = require('node:test');

process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: 'demo-llt-notification-efficiency' });

const {
  enumerateNotificationAudiencePage,
  readOperationsAdminUids,
} = require('../functions/src/domains/notifications/notificationAudienceEnumerators');
const {
  normalizeNotificationAudienceRollout,
} = require('../functions/src/domains/notifications/notificationAudienceRollout');
const {
  evaluateAudienceCandidate,
} = require('../functions/src/domains/notifications/notificationAudiencePage');
const {
  prepareDeliveryPage,
} = require('../functions/src/domains/notifications/notificationWorker');

const snapshot = (value, orderedEntries = Object.entries(value || {})) => ({
  exists: () => value !== null && value !== undefined,
  val: () => value ?? null,
  forEach: (callback) => {
    orderedEntries.forEach(([key, childValue]) => callback({ key, val: () => childValue }));
  },
});

const readPath = (root, pathName) => String(pathName || '').split('/').filter(Boolean)
  .reduce((value, key) => value?.[key], root);

const writePath = (root, pathName, value) => {
  const parts = String(pathName || '').split('/').filter(Boolean);
  let parent = root;
  parts.slice(0, -1).forEach((key) => {
    if (!parent[key] || typeof parent[key] !== 'object') parent[key] = {};
    parent = parent[key];
  });
  const key = parts.at(-1);
  if (value === null) delete parent[key];
  else if (value?.['.sv']?.increment !== undefined) {
    parent[key] = Number(parent[key] || 0) + Number(value['.sv'].increment);
  } else parent[key] = value;
};

const firebaseKeyCompare = (left, right) => {
  const integer = (value) => (/^(0|[1-9]\d*)$/.test(value) && Number(value) <= 2_147_483_647
    ? Number(value)
    : null);
  const leftInteger = integer(left);
  const rightInteger = integer(right);
  if (leftInteger !== null || rightInteger !== null) {
    if (leftInteger === null) return 1;
    if (rightInteger === null) return -1;
    return leftInteger - rightInteger;
  }
  return left < right ? -1 : left > right ? 1 : 0;
};
const compareValues = (left, right) => {
  const leftText = String(left ?? '');
  const rightText = String(right ?? '');
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
};

const createReadDb = (data) => {
  const reads = [];
  const writes = [];
  const ref = (pathName = '') => {
    const state = {
      orderBy: null, child: null, start: null, end: null, limit: Infinity,
    };
    const query = {
      orderByKey: () => { state.orderBy = 'key'; return query; },
      orderByValue: () => { state.orderBy = 'value'; return query; },
      orderByChild: (child) => { state.orderBy = 'child'; state.child = child; return query; },
      equalTo: (value) => { state.equal = value; return query; },
      startAfter: (value, key) => { state.start = { exclusive: true, value, key }; return query; },
      startAt: (value, key) => { state.start = { exclusive: false, value, key }; return query; },
      endAt: (value, key) => { state.end = { value, key }; return query; },
      limitToFirst: (limit) => { state.limit = limit; return query; },
      once: async () => {
        const raw = readPath(data, pathName);
        if (!state.orderBy) {
          reads.push({ path: pathName, kind: 'direct' });
          return snapshot(raw);
        }
        reads.push({ path: pathName, kind: 'query' });
        const ordered = Object.entries(raw || {}).sort(([leftKey, leftValue], [rightKey, rightValue]) => {
          const left = state.orderBy === 'child' ? leftValue?.[state.child]
            : state.orderBy === 'value' ? leftValue : leftKey;
          const right = state.orderBy === 'child' ? rightValue?.[state.child]
            : state.orderBy === 'value' ? rightValue : rightKey;
           return compareValues(left, right) || firebaseKeyCompare(leftKey, rightKey);
        });
        const selected = ordered.filter(([key, value]) => {
          const orderedValue = state.orderBy === 'child' ? value?.[state.child]
            : state.orderBy === 'value' ? value : key;
          if (state.equal !== undefined && orderedValue !== state.equal) return false;
          if (state.start) {
            const valueComparison = compareValues(orderedValue, state.start.value);
             const keyComparison = state.start.key === undefined ? 0 : firebaseKeyCompare(key, state.start.key);
            if (valueComparison < 0 || (valueComparison === 0
              && (state.start.exclusive ? keyComparison <= 0 : keyComparison < 0))) return false;
          }
          if (state.end) {
            const valueComparison = compareValues(orderedValue, state.end.value);
             const keyComparison = state.end.key === undefined ? 0 : firebaseKeyCompare(key, state.end.key);
            if (valueComparison > 0 || (valueComparison === 0 && state.end.key !== undefined && keyComparison > 0)) return false;
          }
          return true;
        }).slice(0, state.limit);
        return snapshot(Object.fromEntries(selected), selected);
      },
      update: async (updates) => {
        Object.entries(updates).forEach(([relativePath, value]) => {
          const updatePath = [pathName, relativePath].filter(Boolean).join('/');
          writePath(data, updatePath, value);
          writes.push({ path: updatePath, value });
        });
      },
      transaction: async (updater) => {
        const current = readPath(data, pathName);
        const next = updater(current ?? null);
        if (next !== undefined) writePath(data, pathName, next);
        writes.push({ path: pathName, value: next });
        return { committed: next !== undefined, snapshot: snapshot(next === undefined ? current : next) };
      },
    };
    return query;
  };
  return { data, ref, reads, writes };
};

const rollout = (phase) => ({ schemaVersion: 1, phase, revision: 1 });

test('single-installation indexed discovery reads exactly the target device at 50k scale', async () => {
  const devices = Object.fromEntries(Array.from({ length: 50_000 }, (_, index) => [
    `uid-${String(index).padStart(5, '0')}`, { registrationRevision: 1 },
  ]));
  devices.target = { registrationRevision: 7, pushToken: 'ExponentPushToken[target-device]' };
  const db = createReadDb({
    notification_audience_rollout: { v1: rollout('indexed') },
    notification_devices: devices,
  });
  const metrics = {};

  const page = await enumerateNotificationAudiencePage({
    db,
    job: { audienceType: 'single_installation', targetInstallationUid: 'target' },
    metrics,
  });

  assert.deepEqual(page.candidates.map(({ authUid }) => authUid), ['target']);
  assert.equal(metrics.candidateRecordsReturned, 1);
  assert.deepEqual(db.reads.filter(({ path }) => path.startsWith('notification_devices')), [
    { path: 'notification_devices/target', kind: 'direct' },
  ]);
});

test('operational indexed discovery returns only the 53 selected candidates with 50k unrelated devices', async () => {
  const devices = Object.fromEntries(Array.from({ length: 50_000 }, (_, index) => [
    `unrelated-${String(index).padStart(5, '0')}`, { operationalTourId: 'tour-other', registrationRevision: 1 },
  ]));
  for (let index = 0; index < 53; index += 1) {
    devices[`selected-${String(index).padStart(2, '0')}`] = {
      operationalTourId: 'tour-selected', registrationRevision: index + 1,
    };
  }
  const db = createReadDb({
    notification_audience_rollout: { v1: rollout('indexed') },
    notification_devices: devices,
  });
  const metrics = {};

  const page = await enumerateNotificationAudiencePage({
    db,
    job: { audienceType: 'tour', tourId: 'tour-selected' },
    metrics,
  });

  assert.equal(page.candidates.length, 53);
  assert(page.candidates.every(({ index }) => index.operationalTourId === 'tour-selected'));
  assert.equal(metrics.candidateRecordsReturned, 53);
  assert.equal(metrics.rtdbQueries, 1);
  assert.deepEqual(db.reads.filter(({ path }) => path === 'notification_devices'), [
    { path: 'notification_devices', kind: 'query' },
  ]);
});

test('operational discovery work is identical with 1,000 or 50,000 unrelated devices', async () => {
  const measure = async (unrelatedCount) => {
    const devices = Object.fromEntries(Array.from({ length: unrelatedCount }, (_, index) => [
      `unrelated-${String(index).padStart(5, '0')}`, { operationalTourId: 'tour-other', registrationRevision: 1 },
    ]));
    for (let index = 0; index < 53; index += 1) {
      devices[`selected-${String(index).padStart(2, '0')}`] = {
        operationalTourId: 'tour-selected', registrationRevision: index + 1,
      };
    }
    const db = createReadDb({
      notification_audience_rollout: { v1: rollout('indexed') },
      notification_devices: devices,
    });
    const metrics = {};
    const page = await enumerateNotificationAudiencePage({
      db, job: { audienceType: 'tour', tourId: 'tour-selected' }, metrics,
    });
    return {
      candidates: page.candidates.length,
      directReads: metrics.rtdbDirectReads,
      queries: metrics.rtdbQueries,
      candidateRecordsReturned: metrics.candidateRecordsReturned,
    };
  };

  assert.deepEqual(await measure(50_000), await measure(1_000));
});

test('indexed continuation preserves Firebase mixed-key order without skips or duplicates', async () => {
  const devices = Object.fromEntries(['a', '10', 'B', '2', 'A'].map((authUid) => [authUid, {
    operationalTourId: 'TOUR_1',
    registrationRevision: 1,
  }]));
  const db = createReadDb({
    notification_audience_rollout: { v1: rollout('indexed') },
    notification_devices: devices,
  });
  const seen = [];
  let cursor = null;
  do {
    const page = await enumerateNotificationAudiencePage({
      db,
      job: { audienceType: 'tour', tourId: 'TOUR_1' },
      cursor,
      pageSize: 2,
    });
    seen.push(...page.candidates.map((candidate) => candidate.authUid));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, ['2', '10', 'A', 'B', 'a']);
  assert.equal(new Set(seen).size, Object.keys(devices).length);
});

test('safety admin enumeration filters enabled values before enforcing the explicit cap', async () => {
  const disabled = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`disabled-${index}`, false]));
  const db = createReadDb({ admin_users: { ...disabled, adminB: true, adminA: true } });
  const uids = await readOperationsAdminUids(db);
  assert.ok(uids.includes('adminA'));
  assert.ok(uids.includes('adminB'));

  const overflow = createReadDb({
    admin_users: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`admin-${index}`, true])),
  });
  await assert.rejects(
    readOperationsAdminUids(overflow),
    (error) => error?.code === 'ADMIN_DIRECTORY_LIMIT_EXCEEDED',
  );
});

test('page preparation reports every bounded work counter from query to provider message', async () => {
  const nowMs = 1_800_000_000_000;
  const session = {
    schemaVersion: 1,
    sessionId: 'sess_v1_0123456789abcdef0123456789abcdef',
    authUid: 'target',
    principalId: 'pax_v2_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    principalType: 'passenger',
    tourId: 'tour-selected',
    driverId: null,
    status: 'active',
    issuedAtMs: nowMs - 1_000,
    lastAuthenticatedAtMs: nowMs - 1_000,
    sessionRevision: 1,
    expiresAtMs: nowMs + 60_000,
  };
  const db = createReadDb({
    notification_audience_rollout: { v1: rollout('indexed') },
    notification_devices: {
      target: {
        registrationRevision: 1,
        operationalTourId: 'tour-selected',
        pushToken: 'ExponentPushToken[instrumented-page-token]',
        status: 'active',
        permissionState: 'granted',
        operationalEligible: true,
      },
      unrelated: { operationalTourId: 'tour-other', registrationRevision: 1 },
    },
    users: { target: {} },
    app_sessions: { target: session },
    tours: {
      'tour-selected': {
        participants: {
          target: {
            schemaVersion: 2,
            principalId: session.principalId,
            sessionId: session.sessionId,
            sessionExpiresAtMs: session.expiresAtMs,
          },
        },
      },
    },
  });
  const job = {
    jobId: 'job-instrumentation',
    audienceType: 'tour',
    tourId: 'tour-selected',
    notificationType: 'tour_announcement',
    expiresAtMs: nowMs + 60_000,
    presentation: { title: 'Test', body: 'Instrumentation' },
    navigation: { screen: 'Tour' },
    deliveryPolicy: {},
  };
  const metrics = {};
  const audience = await enumerateNotificationAudiencePage({ db, job, metrics });
  const prepared = await prepareDeliveryPage(
    db, job, audience.candidates, 'page-instrumentation', nowMs, metrics,
  );

  assert.equal(prepared.prepared.length, 1);
  assert.equal(metrics.rtdbDirectReads, 7);
  assert.equal(metrics.rtdbQueries, 1);
  assert.equal(metrics.transactionAttempts, 4);
  assert.equal(metrics.candidateEvaluations, 1);
  assert.equal(metrics.authorityEvaluations, 1);
  assert.equal(metrics.attemptClaims, 1);
  assert.equal(metrics.providerMessagesPrepared, 1);
});

test('driver delivery rereads current policy generation and exact assignment authority', async () => {
  const nowMs = 1_800_000_000_000;
  const authUid = 'driver-device';
  const driverId = 'DRIVER_1';
  const device = {
    registrationRevision: 3,
    operationalTourId: 'TOUR_1',
    pushToken: 'ExponentPushToken[driver-policy-reread]',
    status: 'active',
    permissionState: 'granted',
    operationalEligible: true,
  };
  const db = createReadDb({
    notification_devices: { [authUid]: device },
    users: { [authUid]: {
      principalType: 'driver', driverId, driverPrincipalId: `driver:${driverId}`,
    } },
    app_sessions: { [authUid]: {
      schemaVersion: 1,
      sessionId: `sess_v1_${'d'.repeat(32)}`,
      authUid,
      principalId: `driver:${driverId}`,
      principalType: 'driver',
      tourId: 'TOUR_1',
      driverId,
      driverLoginPolicyGeneration: 3,
      status: 'active',
      issuedAtMs: nowMs - 1_000,
      lastAuthenticatedAtMs: nowMs - 1_000,
      expiresAtMs: nowMs + 60_000,
      sessionRevision: 1,
    } },
    drivers: { [driverId]: { authUid, currentTourId: 'TOUR_1' } },
    driver_login_policy: { v1: {
      schemaVersion: 1, enforceSingleDevice: false, generation: 3, revision: 1, updatedAtMs: nowMs,
    } },
    tour_manifests: { TOUR_1: { assigned_drivers: { [driverId]: true } } },
  });
  const job = {
    audienceType: 'assigned_drivers',
    tourId: 'TOUR_1',
    notificationType: 'tour_announcement',
    allowedDriverIds: [driverId],
  };
  const candidate = { authUid, source: 'indexed_operational', index: device };
  assert.equal((await evaluateAudienceCandidate({ db, job, candidate, nowMs })).eligible, true);

  db.data.driver_login_policy.v1 = {
    schemaVersion: 1, enforceSingleDevice: true, generation: 4, revision: 2, updatedAtMs: nowMs + 1,
  };
  assert.deepEqual(
    await evaluateAudienceCandidate({ db, job, candidate, nowMs }),
    { eligible: false, reason: 'wrong_tour' },
  );

  db.data.driver_login_policy.v1.generation = 3;
  db.data.tour_manifests.TOUR_1.assigned_drivers[driverId] = false;
  assert.deepEqual(
    await evaluateAudienceCandidate({ db, job, candidate, nowMs }),
    { eligible: false, reason: 'wrong_tour' },
  );
});

test('missing and malformed rollout records fail closed to legacy scan', () => {
  assert.equal(normalizeNotificationAudienceRollout(null).phase, 'legacy_scan');
  assert.equal(normalizeNotificationAudienceRollout({ schemaVersion: 1, phase: 'unknown' }).phase, 'legacy_scan');
  assert.equal(normalizeNotificationAudienceRollout({ schemaVersion: 2, phase: 'indexed' }).phase, 'legacy_scan');
  assert.equal(normalizeNotificationAudienceRollout(rollout('indexed')).phase, 'indexed');
});

test('shadow comparison drains legacy delivery before a non-delivering indexed pass', async () => {
  const db = createReadDb({
    notification_audience_rollout: { v1: rollout('shadow_compare') },
    notification_devices: {
      indexed: { operationalTourId: 'tour-selected', registrationRevision: 1 },
      unrelated: { operationalTourId: 'tour-other', registrationRevision: 1 },
    },
    notification_migrations: { device_registry_v1: { legacyFallbackEnabled: false } },
  });
  const job = { audienceType: 'tour', tourId: 'tour-selected' };

  const legacyPage = await enumerateNotificationAudiencePage({ db, job, pageSize: 100 });
  assert.deepEqual(legacyPage.candidates.map(({ authUid }) => authUid), ['indexed', 'unrelated']);
  assert.equal(legacyPage.shadowIndexedCandidates.length, 0);
  assert.match(legacyPage.nextCursor, /^shadow_v1\|/);

  const legacyExhaustedPage = await enumerateNotificationAudiencePage({
    db, job, pageSize: 100, cursor: legacyPage.nextCursor,
  });
  assert.deepEqual(legacyExhaustedPage.candidates, []);
  assert.equal(legacyExhaustedPage.source, 'legacy');

  const comparisonPage = await enumerateNotificationAudiencePage({
    db, job, pageSize: 100, cursor: legacyExhaustedPage.nextCursor,
  });
  assert.deepEqual(comparisonPage.candidates, []);
  assert.deepEqual(comparisonPage.shadowIndexedCandidates.map(({ authUid }) => authUid), ['indexed']);
  assert.equal(comparisonPage.source, 'shadow_indexed_comparison');
  assert.equal(comparisonPage.nextCursor, null);
});

test('indexed marketing candidates are rejected when revision or tombstone authority is stale', async () => {
  const baseDevice = {
    registrationRevision: 7,
    pushToken: 'ExponentPushToken[marketing-authority-token]',
    status: 'active',
    permissionState: 'granted',
    marketingEligible: true,
    marketingPreferences: { day_trips: true },
  };
  const baseJob = {
    audienceType: 'marketing',
    categoryKey: 'day_trips',
    notificationType: 'future_tour_category_broadcast',
  };
  const staleDb = createReadDb({
    notification_devices: { target: baseDevice },
    notification_consents: { target: { registrationRevision: 6, marketingPreferences: { day_trips: true } } },
  });
  const stale = await evaluateAudienceCandidate({
    db: staleDb,
    job: baseJob,
    candidate: {
      authUid: 'target', source: 'indexed_marketing',
      membership: { schemaVersion: 1, registrationRevision: 6 },
    },
  });
  assert.deepEqual(stale, { eligible: false, reason: 'stale_marketing_index' });

  const current = await evaluateAudienceCandidate({
    db: staleDb,
    job: baseJob,
    candidate: {
      authUid: 'target', source: 'indexed_marketing',
      membership: { schemaVersion: 1, registrationRevision: 7 },
    },
  });
  assert.equal(current.eligible, true);

  const tombstonedDb = createReadDb({
    notification_devices: { target: baseDevice },
    notification_consents: { target: { registrationRevision: 7, marketingPreferences: { day_trips: true } } },
    notification_device_tombstones: { target: { permanent: true, registrationRevision: 7 } },
  });
  const tombstoned = await evaluateAudienceCandidate({
    db: tombstonedDb,
    job: baseJob,
    candidate: {
      authUid: 'target', source: 'indexed_marketing',
      membership: { schemaVersion: 1, registrationRevision: 7 },
    },
  });
  assert.deepEqual(tombstoned, { eligible: false, reason: 'device_deleted' });
});
