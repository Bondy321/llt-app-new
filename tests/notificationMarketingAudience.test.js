const assert = require('node:assert/strict');
const test = require('node:test');

process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: 'demo-llt-marketing-audience' });

const {
  MARKETING_AUDIENCE_ROOT,
  buildMarketingAudienceUpdates,
} = require('../functions/src/domains/notifications/notificationMarketingAudience');
const {
  projectNotificationMarketingAudience,
} = require('../functions/src/domains/notifications/notificationMarketingAudienceProjection');
const {
  PROGRESS_PATH,
  parseArgs,
  readDevicePage,
  run,
} = require('../functions/scripts/backfillNotificationMarketingAudience');

const snapshot = (value, orderedEntries = Object.entries(value || {})) => ({
  exists: () => value !== null && value !== undefined,
  val: () => value ?? null,
  forEach: (callback) => {
    orderedEntries.forEach(([key, childValue]) => callback({ key, val: () => childValue }));
  },
});

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

const pathParts = (pathName) => String(pathName || '').split('/').filter(Boolean);
const readPath = (root, pathName) => pathParts(pathName).reduce((value, key) => value?.[key], root);
const writePath = (root, pathName, value) => {
  const parts = pathParts(pathName);
  if (!parts.length) throw new Error('Root writes must use update');
  let parent = root;
  parts.slice(0, -1).forEach((key) => {
    if (!parent[key] || typeof parent[key] !== 'object') parent[key] = {};
    parent = parent[key];
  });
  const key = parts.at(-1);
  if (value === null || value === undefined) delete parent[key];
  else parent[key] = value;
};

const createMutableDb = (initial = {}, { beforeTransaction } = {}) => {
  const data = structuredClone(initial);
  const reads = [];
  const writes = [];
  const ref = (pathName = '') => {
    const queryState = { orderByKey: false, after: null, limit: Infinity };
    const handle = {
      orderByKey: () => { queryState.orderByKey = true; return handle; },
      startAfter: (value) => { queryState.after = value; return handle; },
      limitToFirst: (value) => { queryState.limit = value; return handle; },
      once: async () => {
        const raw = readPath(data, pathName);
        if (!queryState.orderByKey) {
          reads.push({ path: pathName, kind: 'direct' });
          return snapshot(raw);
        }
        reads.push({ path: pathName, kind: 'query' });
        const selected = Object.entries(raw || {})
          .sort(([left], [right]) => firebaseKeyCompare(left, right))
          .filter(([key]) => !queryState.after || firebaseKeyCompare(key, queryState.after) > 0)
          .slice(0, queryState.limit);
        return snapshot(Object.fromEntries(selected), selected);
      },
      update: async (updates) => {
        Object.entries(updates).forEach(([updatePath, value]) => {
          writePath(data, updatePath, value);
          writes.push({ path: updatePath, value });
        });
      },
      transaction: async (updater) => {
        await beforeTransaction?.({ data, path: pathName });
        const current = readPath(data, pathName);
        const next = updater(current ?? null);
        if (next !== undefined) writePath(data, pathName, next);
        writes.push({ path: pathName, value: next });
        return { committed: next !== undefined, snapshot: snapshot(next) };
      },
    };
    return handle;
  };
  return { data, reads, ref, writes };
};

const marketingDevice = (revision = 5) => ({
  registrationRevision: revision,
  pushToken: 'ExponentPushToken[marketing-projection-token]',
  status: 'active',
  marketingEligible: true,
  marketingPreferences: { day_trips: true, theatre_concerts: false },
});

const marketingConsent = (revision = 5) => ({
  registrationRevision: revision,
  marketingPreferences: { day_trips: true, theatre_concerts: false },
});

test('marketing memberships contain only schema and revision authority', () => {
  const updates = buildMarketingAudienceUpdates({ authUid: 'target', device: marketingDevice(8) });
  assert.deepEqual(updates[`${MARKETING_AUDIENCE_ROOT}/day_trips/target`], {
    schemaVersion: 1, registrationRevision: 8,
  });
  assert.equal(updates[`${MARKETING_AUDIENCE_ROOT}/theatre_concerts/target`], null);
  const persistedValues = Object.values(updates).filter(Boolean);
  assert(persistedValues.every((value) => Object.keys(value).sort().join(',') === 'registrationRevision,schemaVersion'));
  assert(!JSON.stringify(persistedValues).includes('ExponentPushToken'));
});

test('projection writes eligible membership and clears it after a permanent tombstone', async () => {
  const db = createMutableDb({
    notification_devices: { target: marketingDevice(5) },
    notification_consents: { target: marketingConsent(4) },
  });
  await projectNotificationMarketingAudience({
    db, authUid: 'target', afterDevice: marketingDevice(5),
  });
  assert.deepEqual(readPath(db.data, `${MARKETING_AUDIENCE_ROOT}/day_trips/target`), {
    schemaVersion: 1, registrationRevision: 5,
  });

  db.data.notification_device_tombstones = { target: { permanent: true, registrationRevision: 5 } };
  await projectNotificationMarketingAudience({
    db, authUid: 'target', beforeDevice: marketingDevice(5), afterDevice: null,
  });
  assert.equal(readPath(db.data, `${MARKETING_AUDIENCE_ROOT}/day_trips/target`), undefined);
});

test('consent-trigger reconciliation repairs device-first writes and clears revoked consent', async () => {
  const db = createMutableDb({ notification_devices: { target: marketingDevice(9) } });
  await projectNotificationMarketingAudience({ db, authUid: 'target', afterDevice: marketingDevice(9) });
  assert.equal(readPath(db.data, `${MARKETING_AUDIENCE_ROOT}/day_trips/target`), undefined);

  writePath(db.data, 'notification_consents/target', marketingConsent(9));
  await projectNotificationMarketingAudience({ db, authUid: 'target' });
  assert.deepEqual(readPath(db.data, `${MARKETING_AUDIENCE_ROOT}/day_trips/target`), {
    schemaVersion: 1, registrationRevision: 9,
  });

  writePath(db.data, 'notification_consents/target', {
    registrationRevision: 9,
    marketingPreferences: { day_trips: false, theatre_concerts: false },
  });
  await projectNotificationMarketingAudience({ db, authUid: 'target' });
  assert.equal(readPath(db.data, `${MARKETING_AUDIENCE_ROOT}/day_trips/target`), undefined);
});

test('stale projector execution cannot overwrite a newer membership revision', async () => {
  const db = createMutableDb({
    notification_devices: { target: marketingDevice(5) },
    notification_consents: { target: marketingConsent(5) },
    notification_marketing_audience: {
      v1: { day_trips: { target: { schemaVersion: 1, registrationRevision: 6 } } },
    },
  });
  await projectNotificationMarketingAudience({
    db, authUid: 'target', beforeDevice: marketingDevice(4), afterDevice: marketingDevice(5),
  });
  assert.deepEqual(readPath(db.data, `${MARKETING_AUDIENCE_ROOT}/day_trips/target`), {
    schemaVersion: 1, registrationRevision: 6,
  });
});

test('backfill CLI is dry-run by default and requires exact project confirmation for apply', async () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.apply, false);
  assert.equal(defaults.pageSize, 100);
  const db = createMutableDb();
  const admin = {
    app: () => ({ options: { projectId: 'expected-project' } }),
    database: () => db,
  };
  await assert.rejects(
    run({ admin, options: parseArgs(['--apply', '--confirm-project=wrong-project']) }),
    /Refusing apply/,
  );
  assert.equal(db.writes.length, 0);
});

test('dry-run backfill scans every bounded page without projection writes', async () => {
  const devices = {};
  const consents = {};
  for (let index = 0; index < 5; index += 1) {
    const authUid = `uid-${index}`;
    devices[authUid] = marketingDevice(index + 1);
    consents[authUid] = marketingConsent(index + 1);
  }
  const db = createMutableDb({ notification_devices: devices, notification_consents: consents });
  const admin = {
    app: () => ({ options: { projectId: 'expected-project' } }),
    database: () => db,
  };

  const result = await run({
    admin,
    options: parseArgs(['--page-size=2', '--concurrency=2']),
  });

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.scanned, 5);
  assert.equal(result.canonical, 5);
  assert.equal(result.memberships, 5);
  assert.equal(result.complete, true);
  assert.equal(db.reads.filter(({ path, kind }) => path === 'notification_devices' && kind === 'query').length, 3);
  assert.equal(db.writes.length, 0);
});

test('backfill paging follows authoritative Firebase mixed-key order', async () => {
  const db = createMutableDb({
    notification_devices: Object.fromEntries(['a', '10', 'B', '2', 'A'].map((key) => [key, marketingDevice()])),
  });
  const seen = [];
  let cursor = '';
  do {
    const page = await readDevicePage({ db, afterUid: cursor, pageSize: 2 });
    seen.push(...page.entries.map(([key]) => key));
    cursor = page.nextCursor || '';
  } while (cursor);
  assert.deepEqual(seen, ['2', '10', 'A', 'B', 'a']);
});

test('completed apply backfill is a no-op unless restart is explicit', async () => {
  const db = createMutableDb({
    notification_migrations: { marketing_audience_v1: { status: 'complete', recordsScanned: 10 } },
    notification_devices: { target: marketingDevice(5) },
  });
  const admin = {
    app: () => ({ options: { projectId: 'expected-project' } }),
    database: () => db,
  };
  const result = await run({
    admin,
    options: parseArgs(['--apply', '--confirm-project=expected-project']),
  });

  assert.equal(result.alreadyComplete, true);
  assert.equal(result.scanned, 0);
  assert.equal(db.reads.some(({ path }) => path === 'notification_devices'), false);
  assert.equal(db.writes.length, 0);
  assert.deepEqual(readPath(db.data, PROGRESS_PATH), { status: 'complete', recordsScanned: 10 });
});

test('apply backfill refuses manual cursor drift and compare-and-swaps durable progress', async () => {
  const options = parseArgs([
    '--apply', '--confirm-project=expected-project', '--after-uid=A', '--page-size=1',
  ]);
  const db = createMutableDb({ notification_devices: { A: marketingDevice(), B: marketingDevice() } });
  const admin = {
    app: () => ({ options: { projectId: 'expected-project' } }),
    database: () => db,
  };
  await assert.rejects(run({ admin, options }), /cursor override.*--restart/);

  let injected = false;
  const racingDb = createMutableDb({
    notification_migrations: { marketing_audience_v1: { revision: 3, lastCursor: null } },
    notification_devices: { A: marketingDevice(), B: marketingDevice() },
    notification_consents: { A: marketingConsent(), B: marketingConsent() },
  }, {
    beforeTransaction: ({ data, path }) => {
      if (!injected && path === PROGRESS_PATH) {
        injected = true;
        writePath(data, `${PROGRESS_PATH}/revision`, 4);
      }
    },
  });
  await assert.rejects(run({
    admin: { ...admin, database: () => racingDb },
    options: parseArgs(['--apply', '--confirm-project=expected-project', '--page-size=1']),
  }), /progress changed concurrently/);
  assert.equal(readPath(racingDb.data, `${PROGRESS_PATH}/revision`), 4);
});
