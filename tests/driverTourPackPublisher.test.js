const assert = require('node:assert/strict');
const test = require('node:test');

const {
  computeDriverTourPackContentFingerprint,
  validateDriverTourPack,
} = require('../functions/lib/driverTourPackSchema');
const {
  createDriverTourPackPublisher,
  fingerprintPackBatch,
  hashValue,
} = require('../functions/lib/driverTourPackPublisher');
const {
  extractBearerToken,
  validateDriverTourPackHttpRequest,
  verifyManagementOidcRequest,
} = require('../functions/lib/managementOidc');

const departureKey = '2026-09-10::5001D_1';

function validPack(overrides = {}) {
  const pack = {
    schemaVersion: 1,
    departureKey,
    tourId: '5001D_1',
    tourCode: '5001D 1',
    dateISO: '2026-09-10',
    status: 'active',
    sourceSnapshotDate: '2026-08-20',
    generatedAtMs: 1787227200000,
    publishedAtMs: 1787227200000,
    revision: 1,
    contentFingerprint: '',
    expiresAtMs: 1789343999999,
    coverage: {
      tourSummary: true,
      paxByDepPoint: true,
      tourPax: true,
      tourContract: true,
      hotelInfo: true,
      tourItinerary: true,
    },
    quality: {
      state: 'complete',
      matched: 1,
      tourPaxOnly: 0,
      paxOnly: 0,
      conflicts: 0,
      duplicateTourPaxSeats: 0,
      duplicatePaxSeats: 0,
      unseated: 0,
      layoutAnomalies: 0,
      missingReports: 0,
      suppressSeatMap: false,
      pickupManifestPublishable: true,
    },
    tour: {
      name: 'Loch Lomond Day Tour',
      destination: 'Loch Lomond Day Tour',
      routeCode: 'WEST',
      endDateISO: '2026-09-10',
      days: 1,
      status: 'active',
    },
    pickups: {
      pickup_1: {
        pickupId: 'pickup_1',
        dateISO: '2026-09-10',
        time: '08:30',
        name: 'Buchanan Bus Station',
        address: 'Killermont Street',
        passengerCount: 1,
        bookingCount: 1,
        sequence: 0,
      },
    },
    passengers: {
      pax_1: {
        passengerKey: 'pax_1',
        name: 'Jane Example',
        bookingRef: 'BR-100',
        seatLabel: '1',
        pickupId: 'pickup_1',
        bookingLeadContactId: 'lead_1',
        sourceState: 'MATCHED',
        note: '',
      },
    },
    seats: {
      seat_1: { seatId: 'seat_1', label: '1', state: 'occupied', passengerKey: 'pax_1' },
    },
    timeline: {
      event_1: {
        eventId: 'event_1',
        type: 'pickup',
        dateISO: '2026-09-10',
        time: '08:30',
        title: 'Buchanan Bus Station',
        subtitle: 'Killermont Street',
        reference: '',
        notes: '',
        sequence: 0,
      },
    },
    hotels: {},
    services: {},
    coach: { seatMapAvailable: true, layoutSeatCount: 1, details: {} },
    contacts: {
      bookingLeads: {
        lead_1: { contactId: 'lead_1', bookingRef: 'BR-100', phone: '07700 900000' },
      },
      operational: {},
    },
    itineraries: {
      client: { title: '', text: '' },
      driver: { title: 'Loch Lomond Day Tour', text: 'Drive safely.' },
    },
    ...overrides,
  };
  pack.contentFingerprint = computeDriverTourPackContentFingerprint(pack);
  return pack;
}

function descriptor(pack) {
  return {
    departureKey: pack.departureKey,
    tourId: pack.tourId,
    tourCode: pack.tourCode,
    dateISO: pack.dateISO,
    status: pack.status,
    contentFingerprint: pack.contentFingerprint,
  };
}

function secondValidPack() {
  const pack = validPack();
  pack.departureKey = '2026-09-11::5002D_1';
  pack.tourId = '5002D_1';
  pack.tourCode = '5002D 1';
  pack.dateISO = '2026-09-11';
  pack.tour.endDateISO = '2026-09-11';
  pack.pickups.pickup_1.dateISO = '2026-09-11';
  pack.timeline.event_1.dateISO = '2026-09-11';
  pack.contentFingerprint = computeDriverTourPackContentFingerprint(pack);
  return pack;
}

function createMockDatabase(initialState = {}, {
  initialNullTransactionPaths = [],
  initialNullTransactionCalls = {},
} = {}) {
  const state = structuredClone(initialState);
  const pendingInitialNullPaths = new Set(initialNullTransactionPaths);
  const transactionCallCounts = new Map();
  const partsFor = (path) => String(path || '').split('/').filter(Boolean);
  const read = (path) => partsFor(path).reduce((node, part) => node?.[part], state);
  const write = (path, value) => {
    const parts = partsFor(path);
    if (!parts.length) throw new Error('Root replacement is not supported by this test database.');
    let cursor = state;
    parts.slice(0, -1).forEach((part) => {
      if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = {};
      cursor = cursor[part];
    });
    const leaf = parts.at(-1);
    if (value === null) delete cursor[leaf];
    else cursor[leaf] = structuredClone(value);
  };
  const snapshot = (value) => ({
    exists: () => value !== undefined && value !== null,
    val: () => value === undefined ? null : structuredClone(value),
  });
  return {
    state,
    ref(path = '') {
      return {
        async get() { return snapshot(read(path)); },
        async once() { return snapshot(read(path)); },
        async set(value) { write(path, value); },
        async update(updates) {
          Object.entries(updates).forEach(([updatePath, value]) => write(updatePath, value));
        },
        async transaction(updater) {
          const transactionCall = (transactionCallCounts.get(path) || 0) + 1;
          transactionCallCounts.set(path, transactionCall);
          const current = structuredClone(read(path) ?? null);
          const configuredInitialNull = initialNullTransactionCalls[path]?.includes(transactionCall);
          if (pendingInitialNullPaths.delete(path) || configuredInitialNull) {
            const speculative = updater(null);
            if (speculative === undefined) return { committed: false, snapshot: snapshot(current) };
          }
          const next = updater(current);
          if (next === undefined) return { committed: false, snapshot: snapshot(current) };
          write(path, next);
          return { committed: true, snapshot: snapshot(next) };
        },
      };
    },
  };
}

async function beginUploadFinalize({ publisher, pack, runId, startedAtMs, batch = true }) {
  const inventory = [descriptor(pack)];
  const aggregateFingerprint = hashValue(inventory);
  const begun = await publisher.handle({
    action: 'begin',
    runId,
    sourceSnapshotDate: pack.sourceSnapshotDate,
    startedAtMs,
    batchCount: 1,
    inventory,
    aggregateFingerprint,
  });
  const plan = begun.plan[0];
  const materialized = { ...pack, revision: plan.revision, publishedAtMs: plan.publishedAtMs };
  if (!batch) return { begun, materialized, aggregateFingerprint };
  const batchFingerprint = fingerprintPackBatch([materialized]);
  const uploaded = await publisher.handle({
    action: 'upload',
    runId,
    batchIndex: 0,
    packs: [materialized],
    batchFingerprint,
  });
  const finalized = await publisher.handle({ action: 'finalize', runId, aggregateFingerprint });
  return { begun, materialized, batchFingerprint, uploaded, finalized, aggregateFingerprint };
}

test('app schema independently rejects unknown, stale-hash and prohibited private data', () => {
  assert.equal(validateDriverTourPack(validPack()).valid, true);

  const unknown = validPack();
  unknown.sales = 100;
  assert.ok(validateDriverTourPack(unknown).errors.includes('$.sales is unknown.'));

  const stale = validPack();
  stale.tour.destination = 'Changed without hashing';
  assert.ok(validateDriverTourPack(stale).errors.includes('$.contentFingerprint does not match operational content.'));

  const email = validPack();
  email.itineraries.driver.text = 'Contact private@example.com';
  email.contentFingerprint = computeDriverTourPackContentFingerprint(email);
  assert.ok(validateDriverTourPack(email).errors.includes('$.itineraries.driver.text contains prohibited email data.'));
});

test('app schema rejects impossible dates and broken cross-record references', () => {
  const impossibleDate = validPack({ sourceSnapshotDate: '2026-02-30' });
  assert.ok(validateDriverTourPack(impossibleDate).errors.includes('$.sourceSnapshotDate must be a real calendar date.'));

  const broken = validPack();
  broken.passengers.pax_1.pickupId = 'missing_pickup';
  broken.passengers.pax_1.bookingLeadContactId = 'missing_contact';
  broken.seats.seat_1.passengerKey = 'missing_passenger';
  broken.coach.layoutSeatCount = 99;
  broken.contentFingerprint = computeDriverTourPackContentFingerprint(broken);
  const errors = validateDriverTourPack(broken).errors;
  assert.ok(errors.includes('$.passengers.pax_1.pickupId does not reference an existing pickup.'));
  assert.ok(errors.includes('$.passengers.pax_1.bookingLeadContactId does not reference an existing booking lead.'));
  assert.ok(errors.includes('$.seats.seat_1.passengerKey does not reference an existing passenger.'));
  assert.ok(errors.includes('$.coach.layoutSeatCount must equal the number of projected seats.'));
});

test('management OIDC requires the exact verified service-account identity and audience', async () => {
  const request = { get: (name) => name === 'authorization' ? 'Bearer signed-token' : '' };
  const client = {
    verifyIdToken: async ({ idToken, audience }) => {
      assert.equal(idToken, 'signed-token');
      assert.equal(audience, 'https://example.test/ingest');
      return {
        getPayload: () => ({
          sub: 'service-account-subject',
          iss: 'https://accounts.google.com',
          email: 'sync@example.iam.gserviceaccount.com',
          email_verified: true,
        }),
      };
    },
  };
  const identity = await verifyManagementOidcRequest(request, {
    audience: 'https://example.test/ingest',
    expectedEmail: 'sync@example.iam.gserviceaccount.com',
    client,
  });
  assert.equal(identity.email, 'sync@example.iam.gserviceaccount.com');
  assert.equal(extractBearerToken(request), 'signed-token');

  await assert.rejects(
    verifyManagementOidcRequest(request, {
      audience: 'https://example.test/ingest',
      expectedEmail: 'different@example.iam.gserviceaccount.com',
      client,
    }),
    (error) => error.code === 'OIDC_CALLER_FORBIDDEN' && error.status === 403,
  );
  await assert.rejects(
    verifyManagementOidcRequest({ headers: {} }, { client }),
    (error) => error.code === 'OIDC_TOKEN_MISSING',
  );
});

test('the HTTP gate accepts only bounded non-browser JSON POST requests', () => {
  const request = (overrides = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    rawBody: Buffer.from('{}'),
    get(name) { return this.headers[name.toLowerCase()] || ''; },
    ...overrides,
  });
  assert.deepEqual(validateDriverTourPackHttpRequest(request()), { valid: true });
  assert.deepEqual(
    validateDriverTourPackHttpRequest(request({ method: 'GET' })),
    { valid: false, status: 405, code: 'METHOD_NOT_ALLOWED' },
  );
  assert.deepEqual(
    validateDriverTourPackHttpRequest(request({ headers: { 'content-type': 'application/json', origin: 'https://example.com' } })),
    { valid: false, status: 403, code: 'BROWSER_ORIGIN_FORBIDDEN' },
  );
  assert.deepEqual(
    validateDriverTourPackHttpRequest(request({ headers: { 'content-type': 'text/plain' } })),
    { valid: false, status: 415, code: 'JSON_REQUIRED' },
  );
  assert.deepEqual(
    validateDriverTourPackHttpRequest(request({ rawBody: Buffer.alloc(11) }), { maxBodyBytes: 10 }),
    { valid: false, status: 413, code: 'BODY_TOO_LARGE' },
  );
});

test('begin, bounded upload and finalize expose no partial pack and atomically move current', async () => {
  const database = createMockDatabase();
  let nowMs = 1787227200000;
  const publisher = createDriverTourPackPublisher({ database, now: () => nowMs++ });
  const pack = validPack();
  const inventory = [descriptor(pack)];
  const aggregateFingerprint = hashValue(inventory);
  const begun = await publisher.handle({
    action: 'begin',
    runId: 'run_001',
    sourceSnapshotDate: '2026-08-20',
    startedAtMs: 1787227000000,
    batchCount: 1,
    inventory,
    aggregateFingerprint,
  });
  assert.equal(database.state.driver_tour_packs, undefined);
  const materialized = {
    ...pack,
    revision: begun.plan[0].revision,
    publishedAtMs: begun.plan[0].publishedAtMs,
  };
  const batchFingerprint = fingerprintPackBatch([materialized]);
  await publisher.handle({
    action: 'upload',
    runId: 'run_001',
    batchIndex: 0,
    packs: [materialized],
    batchFingerprint,
  });
  assert.equal(database.state.driver_tour_packs, undefined);

  const result = await publisher.handle({ action: 'finalize', runId: 'run_001', aggregateFingerprint });
  assert.deepEqual(result.counts, { created: 1, updated: 0, unchanged: 0, tombstones: 0 });
  assert.equal(database.state.driver_tour_packs[departureKey].revision, 1);
  assert.equal(database.state.driver_tour_pack_ingestion.latestSuccessfulRun.runId, 'run_001');
  assert.deepEqual(database.state.driver_tour_pack_ingestion.staging, {});
  assert.equal(database.state.driver_tour_pack_ingestion.activeRun, undefined);
});

test('upload survives RTDB initial-null transaction callbacks without opening partial state', async () => {
  const runPath = 'driver_tour_pack_ingestion/runs/run_initial_null';
  const database = createMockDatabase({}, { initialNullTransactionPaths: [runPath] });
  let nowMs = 1787227200000;
  const publisher = createDriverTourPackPublisher({ database, now: () => nowMs++ });
  const result = await beginUploadFinalize({
    publisher,
    pack: validPack(),
    runId: 'run_initial_null',
    startedAtMs: 1787227000000,
  });

  assert.equal(result.uploaded.idempotent, false);
  assert.equal(result.finalized.counts.created, 1);
  assert.equal(database.state.driver_tour_pack_ingestion.runs.run_initial_null.status, 'FINALIZED');
  assert.equal(database.state.driver_tour_pack_ingestion.latestSuccessfulRun.runId, 'run_initial_null');
});

test('finalize survives an RTDB initial-null lease transition and moves current atomically', async () => {
  const activeRunPath = 'driver_tour_pack_ingestion/activeRun';
  const database = createMockDatabase({}, {
    initialNullTransactionCalls: { [activeRunPath]: [2] },
  });
  let nowMs = 1787227200000;
  const publisher = createDriverTourPackPublisher({ database, now: () => nowMs++ });
  const result = await beginUploadFinalize({
    publisher,
    pack: validPack(),
    runId: 'run_finalize_initial_null',
    startedAtMs: 1787227000000,
  });

  assert.equal(result.finalized.counts.created, 1);
  assert.equal(database.state.driver_tour_pack_ingestion.activeRun, undefined);
  assert.equal(database.state.driver_tour_pack_ingestion.latestSuccessfulRun.runId, 'run_finalize_initial_null');
  assert.equal(database.state.driver_tour_packs[departureKey].departureKey, departureKey);
});

test('identical retries and identical later runs are idempotent without revision churn', async () => {
  const database = createMockDatabase();
  let nowMs = 1787227200000;
  const publisher = createDriverTourPackPublisher({ database, now: () => nowMs++ });
  const first = await beginUploadFinalize({
    publisher,
    pack: validPack(),
    runId: 'run_001',
    startedAtMs: 1787227000000,
  });
  const repeatedFinalize = await publisher.handle({
    action: 'finalize',
    runId: 'run_001',
    aggregateFingerprint: first.aggregateFingerprint,
  });
  assert.equal(repeatedFinalize.idempotent, true);
  const repeatedUpload = await publisher.handle({
    action: 'upload',
    runId: 'run_001',
    batchIndex: 0,
    packs: [first.materialized],
    batchFingerprint: first.batchFingerprint,
  });
  assert.equal(repeatedUpload.idempotent, true);

  nowMs += 1_000;
  const sameContent = validPack({
    generatedAtMs: validPack().generatedAtMs + 60_000,
    sourceSnapshotDate: '2026-08-21',
  });
  const second = await beginUploadFinalize({
    publisher,
    pack: sameContent,
    runId: 'run_002',
    startedAtMs: 1787228000000,
  });
  assert.equal(second.begun.plan[0].action, 'noop');
  assert.equal(second.materialized.revision, 1);
  assert.equal(second.finalized.counts.unchanged, 1);
  assert.equal(database.state.driver_tour_packs[departureKey].generatedAtMs, validPack().generatedAtMs);
});

test('changed content increments revision and explicit tombstones remove operational payloads', async () => {
  const database = createMockDatabase();
  let nowMs = 1787227200000;
  const publisher = createDriverTourPackPublisher({ database, now: () => nowMs++ });
  await beginUploadFinalize({ publisher, pack: validPack(), runId: 'run_001', startedAtMs: 1787227000000 });

  const changed = validPack();
  changed.tour.destination = 'Changed destination';
  changed.contentFingerprint = computeDriverTourPackContentFingerprint(changed);
  const update = await beginUploadFinalize({ publisher, pack: changed, runId: 'run_002', startedAtMs: 1787228000000 });
  assert.equal(update.materialized.revision, 2);
  assert.equal(update.finalized.counts.updated, 1);

  const tombstone = validPack({
    status: 'cancelled',
    coverage: Object.fromEntries(Object.keys(validPack().coverage).map((key) => [key, false])),
    quality: {
      state: 'complete', matched: 0, tourPaxOnly: 0, paxOnly: 0, conflicts: 0,
      duplicateTourPaxSeats: 0, duplicatePaxSeats: 0, unseated: 0,
      layoutAnomalies: 0, missingReports: 0, suppressSeatMap: true,
      pickupManifestPublishable: false,
    },
    tour: { name: '', destination: '', routeCode: '', endDateISO: '2026-09-10', days: 1, status: 'cancelled' },
    pickups: {}, passengers: {}, seats: {}, timeline: {}, hotels: {}, services: {},
    coach: { seatMapAvailable: false, layoutSeatCount: 0, details: {} },
    contacts: { bookingLeads: {}, operational: {} },
    itineraries: { client: { title: '', text: '' }, driver: { title: '', text: '' } },
  });
  tombstone.contentFingerprint = computeDriverTourPackContentFingerprint(tombstone);
  const cancelled = await beginUploadFinalize({ publisher, pack: tombstone, runId: 'run_003', startedAtMs: 1787229000000 });
  assert.equal(cancelled.finalized.counts.tombstones, 1);
  assert.equal(database.state.driver_tour_packs[departureKey].status, 'cancelled');
  assert.deepEqual(database.state.driver_tour_packs[departureKey].passengers, {});
  assert.equal(database.state.driver_tour_pack_tombstones[departureKey].status, 'cancelled');
  assert.deepEqual(database.state.driver_tour_pack_admin_status[departureKey], {
    schemaVersion: 1, departureKey, tourId: '5001D_1', tourCode: '5001D 1', dateISO: '2026-09-10',
    status: 'cancelled', qualityState: 'complete', revision: 3,
    publishedAtMs: cancelled.materialized.publishedAtMs, expiresAtMs: tombstone.expiresAtMs,
    sourceSnapshotDate: tombstone.sourceSnapshotDate, runId: 'run_003',
  });
});

test('tombstones fail closed if any coach, contact, itinerary, or tour text remains', () => {
  const tombstone = validPack({
    status: 'cancelled',
    pickups: {}, passengers: {}, seats: {}, timeline: {}, hotels: {}, services: {},
    tour: { name: '', destination: '', routeCode: '', endDateISO: '2026-09-10', days: 1, status: 'cancelled' },
    coach: { seatMapAvailable: false, layoutSeatCount: 0, details: {} },
    contacts: { bookingLeads: {}, operational: {} },
    itineraries: { client: { title: '', text: '' }, driver: { title: '', text: 'private instruction' } },
  });
  tombstone.contentFingerprint = computeDriverTourPackContentFingerprint(tombstone);
  const result = validateDriverTourPack(tombstone);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /itineraries must contain no operational text/);
});

test('a missing departure is never interpreted as deletion', async () => {
  const database = createMockDatabase();
  let nowMs = 1787227200000;
  const publisher = createDriverTourPackPublisher({ database, now: () => nowMs++ });
  const firstPacks = [validPack(), secondValidPack()];
  const firstInventory = firstPacks.map(descriptor).sort((left, right) => left.departureKey.localeCompare(right.departureKey));
  const firstAggregate = hashValue(firstInventory);
  const begun = await publisher.handle({
    action: 'begin',
    runId: 'run_001',
    sourceSnapshotDate: '2026-08-20',
    startedAtMs: 1787227000000,
    batchCount: 1,
    inventory: firstInventory,
    aggregateFingerprint: firstAggregate,
  });
  const plan = new Map(begun.plan.map((item) => [item.departureKey, item]));
  const materialized = firstPacks.map((pack) => ({
    ...pack,
    revision: plan.get(pack.departureKey).revision,
    publishedAtMs: plan.get(pack.departureKey).publishedAtMs,
  }));
  await publisher.handle({
    action: 'upload',
    runId: 'run_001',
    batchIndex: 0,
    packs: materialized,
    batchFingerprint: fingerprintPackBatch(materialized),
  });
  await publisher.handle({ action: 'finalize', runId: 'run_001', aggregateFingerprint: firstAggregate });

  await beginUploadFinalize({
    publisher,
    pack: validPack({ sourceSnapshotDate: '2026-08-21' }),
    runId: 'run_002',
    startedAtMs: 1787228000000,
  });
  assert.equal(database.state.driver_tour_packs['2026-09-11::5002D_1'].tourId, '5002D_1');
  assert.equal(database.state.driver_tour_pack_ingestion.packMetadata['2026-09-11::5002D_1'].revision, 1);
});

test('run and pack source snapshots must be real and identical', async () => {
  const database = createMockDatabase();
  const publisher = createDriverTourPackPublisher({ database, now: () => 1787227200000 });
  const pack = validPack();
  const inventory = [descriptor(pack)];
  const aggregateFingerprint = hashValue(inventory);

  await assert.rejects(
    publisher.handle({
      action: 'begin',
      runId: 'bad_date',
      sourceSnapshotDate: '2026-02-30',
      startedAtMs: 1787227000000,
      batchCount: 1,
      inventory,
      aggregateFingerprint,
    }),
    (error) => error.code === 'INVALID_SOURCE_DATE',
  );

  const begun = await publisher.handle({
    action: 'begin',
    runId: 'source_mismatch',
    sourceSnapshotDate: '2026-08-20',
    startedAtMs: 1787227000000,
    batchCount: 1,
    inventory,
    aggregateFingerprint,
  });
  const plan = begun.plan[0];
  const mismatchedPack = validPack({
    sourceSnapshotDate: '2026-08-19',
    revision: plan.revision,
    publishedAtMs: plan.publishedAtMs,
  });
  await assert.rejects(
    publisher.handle({
      action: 'upload',
      runId: 'source_mismatch',
      batchIndex: 0,
      packs: [mismatchedPack],
      batchFingerprint: fingerprintPackBatch([mismatchedPack]),
    }),
    (error) => error.code === 'PACK_SOURCE_SNAPSHOT_MISMATCH',
  );
});

test('partial, stale and conflicting publications cannot replace a good current pack', async () => {
  const database = createMockDatabase();
  let nowMs = 1787227200000;
  const publisher = createDriverTourPackPublisher({ database, now: () => nowMs++ });
  const first = await beginUploadFinalize({ publisher, pack: validPack(), runId: 'run_001', startedAtMs: 1787227000000 });
  const currentHash = database.state.driver_tour_packs[departureKey].contentFingerprint;

  const pending = await beginUploadFinalize({
    publisher,
    pack: validPack({ sourceSnapshotDate: '2026-08-21' }),
    runId: 'run_002',
    startedAtMs: 1787228000000,
    batch: false,
  });
  await assert.rejects(
    publisher.handle({ action: 'finalize', runId: 'run_002', aggregateFingerprint: pending.aggregateFingerprint }),
    (error) => error.code === 'RUN_INCOMPLETE',
  );
  assert.equal(database.state.driver_tour_packs[departureKey].contentFingerprint, currentHash);
  assert.equal(database.state.driver_tour_pack_ingestion.latestSuccessfulRun.runId, 'run_001');

  await assert.rejects(
    publisher.handle({
      action: 'begin',
      runId: 'run_001',
      sourceSnapshotDate: '2026-08-20',
      startedAtMs: 1787227000000,
      batchCount: 1,
      inventory: [descriptor(validPack({ tourCode: 'DIFFERENT' }))],
      aggregateFingerprint: hashValue([descriptor(validPack({ tourCode: 'DIFFERENT' }))]),
    }),
    (error) => error.code === 'RUN_REPLAY_CONFLICT',
  );

  const staleDatabase = createMockDatabase({
    driver_tour_pack_ingestion: {
      latestSuccessfulRun: {
        runId: 'latest',
        sourceSnapshotDate: '2026-08-20',
        startedAtMs: 1787227000000,
      },
    },
  });
  const stalePublisher = createDriverTourPackPublisher({ database: staleDatabase, now: () => nowMs++ });
  await assert.rejects(
    stalePublisher.handle({
      action: 'begin',
      runId: 'stale_run',
      sourceSnapshotDate: '2026-08-19',
      startedAtMs: 1787226000000,
      batchCount: 1,
      inventory: [descriptor(validPack())],
      aggregateFingerprint: first.aggregateFingerprint,
    }),
    (error) => error.code === 'STALE_RUN',
  );
});
