'use strict';

// @ts-check

const { onValueWritten } = require('firebase-functions/v2/database');
const { randomUUID } = require('node:crypto');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { snapshotEntriesInQueryOrder } = require('../../infrastructure/database/rtdbQueryOrder');
const {
  ASSIGNED_DRIVER_LIMIT,
  COACH_TRACKING_ROOT,
  COACH_TRACKING_SCHEMA_VERSION,
  COACH_TRACKING_STATUS_PATH,
  buildCoachTrackingRow,
} = require('./coachTrackingProjection');

const REGION = 'europe-west1';
const INSTANCE = 'loch-lomond-travel-default-rtdb';
const PAGE_SIZE_DEFAULT = 100;
const PAGE_SIZE_MAX = 250;
const BATCH_CONCURRENCY = 5;
const ROW_LEASE_TTL_MS = 5 * 60_000;
const BACKFILL_LEASE_TTL_MS = 5 * 60_000;
const options = Object.freeze({ region: REGION, instance: INSTANCE, retry: true, maxInstances: 20 });

const readValue = async (db, path) => (await db.ref(path).once('value')).val();

const readAssignedDrivers = async (db, tourId) => {
  const snapshot = await db.ref('drivers')
    .orderByChild('currentTourId')
    .equalTo(tourId)
    .limitToFirst(ASSIGNED_DRIVER_LIMIT + 1)
    .once('value');
  const allEntries = snapshotEntriesInQueryOrder(snapshot);
  const entries = allEntries
    .filter(([, driver]) => driver?.currentTourId === tourId)
    .sort(([left], [right]) => left.localeCompare(right));
  const assignmentOverflow = allEntries.length > ASSIGNED_DRIVER_LIMIT;
  return {
    assignmentOverflow,
    assignedDrivers: entries.slice(0, ASSIGNED_DRIVER_LIMIT).map(([driverId, driver]) => ({
      driverId,
      name: typeof driver?.name === 'string' ? driver.name : driverId,
    })),
  };
};

const reservationPath = (tourId) => `admin_dashboard/v1/internal/coach_tracking_reservations/${tourId}`;

const reserveRowGeneration = async ({ reservationRef, owner, rowRevision, nowMs }) => {
  let reservation = null;
  const result = await reservationRef.transaction((current) => {
    if (Number(current?.expiresAtMs || 0) > nowMs) return current;
    const generation = Math.max(Number(current?.generation || 0), rowRevision) + 1;
    reservation = { schemaVersion: 1, owner, generation, expiresAtMs: nowMs + ROW_LEASE_TTL_MS };
    return reservation;
  }, undefined, false);
  const stored = result.snapshot?.val?.() || null;
  return result.committed && stored?.owner === owner && stored?.generation === reservation?.generation
    && Number(stored?.expiresAtMs || 0) > nowMs ? stored : null;
};

const publishRowGenerationFence = async ({ db, tourId, reservation, nowMs }) => {
  const rowRef = db.ref(`${COACH_TRACKING_ROOT}/${tourId}`);
  const fence = await rowRef.transaction((current) => {
    if (Number(current?.projectionRevision || 0) >= reservation.generation) return current;
    return current
      ? { ...current, projectionRevision: reservation.generation }
      : { schemaVersion: COACH_TRACKING_SCHEMA_VERSION, tourId, listed: false, deleted: true,
        updatedAtMs: nowMs, projectionRevision: reservation.generation };
  }, undefined, false);
  return fence.committed && Number(fence.snapshot?.val?.()?.projectionRevision || 0) === reservation.generation;
};

const claimRowReservation = async ({ db, tourId, owner, nowMs = Date.now() }) => {
  const reservationRef = db.ref(reservationPath(tourId));
  const rowRevision = Number((await readValue(db, `${COACH_TRACKING_ROOT}/${tourId}`))?.projectionRevision || 0);
  const reservation = await reserveRowGeneration({ reservationRef, owner, rowRevision, nowMs });
  if (!reservation) return null;
  // Publish the generation fence before any source reads. A slow prior
  // reconciler can no longer overwrite this generation while it is preparing.
  const fencePublished = await publishRowGenerationFence({ db, tourId, reservation, nowMs });
  if (!fencePublished) {
    await releaseRowReservation({ db, tourId, reservation });
    return null;
  }
  return reservation;
};

const refreshRowReservation = async ({ db, tourId, reservation }) => {
  const reservationRef = db.ref(reservationPath(tourId));
  const nowMs = Date.now();
  const result = await reservationRef.transaction((current) => {
    if (current === null) return current;
    if (current?.owner !== reservation.owner
      || current?.generation !== reservation.generation
      || Number(current?.expiresAtMs || 0) <= nowMs) return current;
    return { ...current, expiresAtMs: nowMs + ROW_LEASE_TTL_MS };
  }, undefined, false);
  const stored = result.snapshot?.val?.() || null;
  if (!result.committed || stored?.owner !== reservation.owner
    || stored?.generation !== reservation.generation || Number(stored?.expiresAtMs || 0) <= Date.now()) {
    const error = new Error('Coach tracking reconciliation lost its reservation');
    error.code = 'COACH_TRACKING_RESERVATION_LOST';
    throw error;
  }
  return stored;
};

const releaseRowReservation = async ({ db, tourId, reservation }) => {
  const reservationRef = db.ref(reservationPath(tourId));
  await reservationRef.transaction((current) => (
    current?.owner === reservation.owner && current?.generation === reservation.generation
      ? { ...current, expiresAtMs: 0 }
      : current
  ), undefined, false);
};

const writeFencedCoachTrackingRow = async ({ db, tourId, reservation, row }) => {
  const refreshedReservation = await refreshRowReservation({ db, tourId, reservation });
  const rowRef = db.ref(`${COACH_TRACKING_ROOT}/${tourId}`);
  const updatedAtMs = Date.now();
  const next = row
    ? { ...row, updatedAtMs, projectionRevision: reservation.generation }
    : {
      schemaVersion: COACH_TRACKING_SCHEMA_VERSION,
      tourId,
      listed: false,
      deleted: true,
      updatedAtMs,
      projectionRevision: reservation.generation,
    };
  let transactionOutcome = 'pending';
  const result = await rowRef.transaction((current) => {
    if (Date.now() >= refreshedReservation.expiresAtMs) {
      transactionOutcome = 'expired';
      return current;
    }
    if (Number(current?.projectionRevision || 0) > reservation.generation) {
      transactionOutcome = 'superseded';
      return current;
    }
    transactionOutcome = 'written';
    return { ...next, listed: Boolean(row) };
  }, undefined, false);
  const committedRow = result.snapshot?.val?.() || null;
  if (transactionOutcome !== 'written' || Number(committedRow?.projectionRevision || 0) !== reservation.generation
    || (row ? committedRow?.sourceFingerprint !== row.sourceFingerprint : committedRow?.deleted !== true)) {
    const error = new Error('Coach tracking row commit was fenced; retry reconciliation');
    error.code = 'COACH_TRACKING_RESERVATION_LOST';
    throw error;
  }
  return committedRow;
};

/**
 * Re-read latest tour/location/assignment state while holding the shared
 * per-tour reconciliation lease. Event payloads are intentionally ignored so
 * delayed writes cannot restore an older assignment or location.
 */
const reconcileCoachTrackingTour = async ({ db, tourId, nowMs = Date.now() }) => {
  if (!db?.ref || !isValidFirebaseKey(tourId)) return { applied: false, reason: 'invalid_tour_id' };
  const owner = `coach-tracking:${tourId}:${randomUUID()}`;
  const reservation = await claimRowReservation({ db, tourId, owner, nowMs });
  if (!reservation) {
    const error = new Error('Coach tracking reconciliation is already in progress');
    error.code = 'COACH_TRACKING_LOCKED';
    throw error;
  }
  try {
    const fields = ['tourCode', 'name', 'startDateEpochMs', 'endDateEpochMs', 'isActive', 'driverLocation'];
    const values = await Promise.all(fields.map((field) => readValue(db, `tours/${tourId}/${field}`)));
    const tour = Object.fromEntries(fields.map((field, index) => [field, values[index]]));
    const tourHasSource = fields.slice(0, -1).some((field) => tour[field] !== null && tour[field] !== undefined)
      || tour.driverLocation !== null;
    if (!tourHasSource) {
      await writeFencedCoachTrackingRow({ db, tourId, reservation, row: null });
      return { applied: true, deleted: true };
    }
    const { assignedDrivers, assignmentOverflow } = await readAssignedDrivers(db, tourId);
    const row = buildCoachTrackingRow({ tourId, tour, assignedDrivers, assignmentOverflow, nowMs: Date.now() });
    await writeFencedCoachTrackingRow({ db, tourId, reservation, row });
    return { applied: true, deleted: !row, assignmentOverflow };
  } finally {
    await releaseRowReservation({ db, tourId, reservation });
  }
};

const reconcileTourEvent = (event) => reconcileCoachTrackingTour({
  db: admin.database(),
  tourId: event.params.tourId,
});

const reconcileDriverCurrentTourEvent = async (event) => {
  const db = admin.database();
  const driverId = event.params.driverId;
  if (!isValidFirebaseKey(driverId)) return null;
  const before = event.data?.before?.val?.() || null;
  const after = event.data?.after?.val?.() || null;
  const tourIds = [...new Set([before, after]
    .filter((tourId) => typeof tourId === 'string' && isValidFirebaseKey(tourId)))];
  for (const tourId of tourIds) await reconcileCoachTrackingTour({ db, tourId });
  return null;
};

const reconcileDriverTourNow = async (event) => {
  const db = admin.database();
  const driverId = event.params.driverId;
  if (!isValidFirebaseKey(driverId)) return null;
  const currentTourId = await readValue(db, `drivers/${driverId}/currentTourId`);
  if (typeof currentTourId === 'string' && isValidFirebaseKey(currentTourId)) {
    await reconcileCoachTrackingTour({ db, tourId: currentTourId });
  }
  return null;
};

const projectCoachTrackingLocation = onValueWritten({ ...options, ref: '/tours/{tourId}/driverLocation' }, reconcileTourEvent);

const tourFieldTriggers = Object.fromEntries([
  ['projectCoachTrackingTourName', 'name'],
  ['projectCoachTrackingTourCode', 'tourCode'],
  ['projectCoachTrackingTourStartIndex', 'startDateEpochMs'],
  ['projectCoachTrackingTourEndIndex', 'endDateEpochMs'],
  ['projectCoachTrackingTourActive', 'isActive'],
].map(([name, field]) => [name, onValueWritten({ ...options, ref: `/tours/{tourId}/${field}` }, reconcileTourEvent)]));

const projectCoachTrackingDriverCurrentTour = onValueWritten(
  { ...options, ref: '/drivers/{driverId}/currentTourId' }, reconcileDriverCurrentTourEvent,
);
const projectCoachTrackingDriverName = onValueWritten(
  { ...options, ref: '/drivers/{driverId}/name' }, reconcileDriverTourNow,
);
const readDriverPage = async ({ db, pageSize, cursor }) => {
  const query = db.ref('drivers').orderByChild('currentTourId');
  const pageQuery = cursor ? query.startAt(cursor.value, cursor.key) : query.startAt('');
  const snapshot = await pageQuery.limitToFirst(pageSize + (cursor ? 2 : 1)).once('value');
  const all = snapshotEntriesInQueryOrder(snapshot);
  const afterCursor = cursor && all[0]?.[0] === cursor.key ? all.slice(1) : all;
  const hasMore = afterCursor.length > pageSize;
  const page = afterCursor.slice(0, pageSize);
  const last = page.at(-1);
  return {
    tourIds: [...new Set(page.map(([, driver]) => driver?.currentTourId)
      .filter((value) => typeof value === 'string' && isValidFirebaseKey(value)))],
    hasMore,
    nextCursor: hasMore && last ? { key: last[0], value: String(last[1]?.currentTourId || '') } : null,
    rows: page.length,
  };
};

const readLocationPage = async ({ db, pageSize, cursor }) => {
  let query = db.ref('tours').orderByChild('driverLocation/timestamp');
  query = cursor ? query.startAt(cursor.value, cursor.key) : query.startAt(1);
  const snapshot = await query.limitToFirst(pageSize + (cursor ? 2 : 1)).once('value');
  const all = snapshotEntriesInQueryOrder(snapshot);
  const afterCursor = cursor && all[0]?.[0] === cursor.key ? all.slice(1) : all;
  const hasMore = afterCursor.length > pageSize;
  const page = afterCursor.slice(0, pageSize);
  const last = page.at(-1);
  return {
    tourIds: page.map(([tourId]) => tourId).filter(isValidFirebaseKey),
    hasMore,
    nextCursor: hasMore && last ? { key: last[0], value: last[1]?.driverLocation?.timestamp } : null,
    rows: page.length,
  };
};

const readExistingCoachTrackingPage = async ({ db, pageSize, cursor }) => {
  let query = db.ref(COACH_TRACKING_ROOT).orderByChild('listed');
  query = cursor ? query.startAt(true, cursor).endAt(true) : query.startAt(true).endAt(true);
  const snapshot = await query.limitToFirst(pageSize + (cursor ? 2 : 1)).once('value');
  const entries = snapshotEntriesInQueryOrder(snapshot);
  const afterCursor = cursor && entries[0]?.[0] === cursor ? entries.slice(1) : entries;
  const hasMore = afterCursor.length > pageSize;
  const page = afterCursor.slice(0, pageSize);
  return {
    tourIds: page.map(([tourId]) => tourId).filter(isValidFirebaseKey),
    hasMore,
    nextCursor: hasMore ? page.at(-1)?.[0] || null : null,
    rows: page.length,
  };
};

const mapWithConcurrency = async (items, limit, mapper) => {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await mapper(items[index]);
    }
  });
  await Promise.all(workers);
};

const claimBackfillRunLock = async ({ statusRef, runId, nowMs = Date.now() }) => {
  const result = await statusRef.transaction((current) => {
    if (current?.state === 'building' && Number(current?.runLeaseUntilMs || 0) > nowMs) return current;
    return {
      schemaVersion: COACH_TRACKING_SCHEMA_VERSION,
      state: 'building',
      runId,
      runLeaseUntilMs: nowMs + BACKFILL_LEASE_TTL_MS,
    };
  }, undefined, false);
  const stored = result.snapshot?.val?.() || null;
  if (!result.committed || stored?.runId !== runId || stored?.state !== 'building'
    || Number(stored?.runLeaseUntilMs || 0) <= nowMs) {
    const error = new Error('A coach tracking backfill is already in progress');
    error.code = 'COACH_TRACKING_BACKFILL_IN_PROGRESS';
    throw error;
  }
};

const refreshBackfillRunLock = async ({ statusRef, runId }) => {
  const nowMs = Date.now();
  const result = await statusRef.transaction((current) => {
    if (current === null) return current;
    if (current?.runId !== runId || current?.state !== 'building'
      || Number(current?.runLeaseUntilMs || 0) <= nowMs) return current;
    return { ...current, runLeaseUntilMs: nowMs + BACKFILL_LEASE_TTL_MS };
  }, undefined, false);
  const stored = result.snapshot?.val?.() || null;
  if (!result.committed || stored?.runId !== runId || stored?.state !== 'building'
    || Number(stored?.runLeaseUntilMs || 0) <= Date.now()) {
    const error = new Error('Coach tracking backfill lost its run lock');
    error.code = 'COACH_TRACKING_BACKFILL_SUPERSEDED';
    throw error;
  }
};

const finishBackfillRun = async ({ statusRef, runId, state, completedAtMs }) => {
  const result = await statusRef.transaction((current) => {
    if (current === null) return current;
    if (current?.runId !== runId || current?.state !== 'building') return current;
    return {
      schemaVersion: COACH_TRACKING_SCHEMA_VERSION,
      state,
      runId,
      ...(state === 'ready' ? { completedAtMs } : {}),
    };
  }, undefined, false);
  const stored = result.snapshot?.val?.() || null;
  return result.committed && stored?.runId === runId && stored?.state === state;
};

const normalizeBackfillSettings = ({ pageSize, concurrency }) => ({
  pageSize: Number.isSafeInteger(pageSize) && pageSize > 0
    ? Math.min(pageSize, PAGE_SIZE_MAX) : PAGE_SIZE_DEFAULT,
  concurrency: Number.isSafeInteger(concurrency) && concurrency > 0
    ? Math.min(concurrency, 10) : BATCH_CONCURRENCY,
});

const reportBackfillPage = ({ page, source, candidateTourIds, onProgress, pageNumber }) => {
  page.tourIds.forEach((tourId) => candidateTourIds.add(tourId));
  onProgress({ source, page: pageNumber, rows: page.rows, candidateCount: candidateTourIds.size });
};

const scanBackfillSources = async ({ db, pageSize, maxPages, apply, runId, statusRef, onProgress }) => {
  const candidateTourIds = new Set();
  const state = {
    driverCursor: null, locationCursor: null, existingCursor: null,
    driverPages: 0, locationPages: 0, existingPages: 0,
    driverDone: false, locationDone: false, existingDone: false,
  };
  const scannedPages = () => state.driverPages + state.locationPages + state.existingPages;
  while ((!state.driverDone || !state.locationDone || !state.existingDone) && scannedPages() < maxPages) {
    if (apply) await refreshBackfillRunLock({ statusRef, runId });
    if (!state.driverDone) {
      const page = await readDriverPage({ db, pageSize, cursor: state.driverCursor });
      state.driverPages += 1;
      state.driverCursor = page.nextCursor;
      state.driverDone = !page.hasMore;
      reportBackfillPage({ page, source: 'drivers', candidateTourIds, onProgress, pageNumber: state.driverPages });
    }
    if (!state.locationDone && scannedPages() < maxPages) {
      const page = await readLocationPage({ db, pageSize, cursor: state.locationCursor });
      state.locationPages += 1;
      state.locationCursor = page.nextCursor;
      state.locationDone = !page.hasMore;
      reportBackfillPage({ page, source: 'locations', candidateTourIds, onProgress, pageNumber: state.locationPages });
    }
    if (!state.existingDone && scannedPages() < maxPages) {
      const page = await readExistingCoachTrackingPage({ db, pageSize, cursor: state.existingCursor });
      state.existingPages += 1;
      state.existingCursor = page.nextCursor;
      state.existingDone = !page.hasMore;
      reportBackfillPage({ page, source: 'existing_rows', candidateTourIds, onProgress, pageNumber: state.existingPages });
    }
  }
  return { candidateTourIds, ...state };
};

const reconcileBackfillCandidates = async ({ db, candidateIds, pageSize, concurrency, runId, statusRef }) => {
  let reconciled = 0;
  for (let offset = 0; offset < candidateIds.length; offset += pageSize) {
    await refreshBackfillRunLock({ statusRef, runId });
    const batch = candidateIds.slice(offset, offset + pageSize);
    await mapWithConcurrency(batch, concurrency, async (tourId) => {
      await reconcileCoachTrackingTour({ db, tourId });
      reconciled += 1;
    });
  }
  return reconciled;
};

const finalizeBackfillReadiness = async ({ statusRef, runId, scan }) => {
  if (!scan.driverDone || !scan.locationDone || !scan.existingDone) return;
  await refreshBackfillRunLock({ statusRef, runId });
  const completed = await finishBackfillRun({ statusRef, runId, state: 'ready', completedAtMs: Date.now() });
  if (!completed) {
    const error = new Error('Coach tracking backfill was superseded before completion');
    error.code = 'COACH_TRACKING_BACKFILL_SUPERSEDED';
    throw error;
  }
};

const executeCoachTrackingBackfill = async ({
  db, apply, settings, maxPages, runId, statusRef, onProgress,
}) => {
  try {
    const scan = await scanBackfillSources({
      db, pageSize: settings.pageSize, maxPages, apply, runId, statusRef, onProgress,
    });
    const candidateIds = [...scan.candidateTourIds];
    const candidatesReconciled = apply
      ? await reconcileBackfillCandidates({
        db, candidateIds, pageSize: settings.pageSize, concurrency: settings.concurrency, runId, statusRef,
      })
      : 0;
    if (apply) await finalizeBackfillReadiness({ statusRef, runId, scan });
    return {
      dryRun: !apply,
      applied: apply,
      complete: scan.driverDone && scan.locationDone && scan.existingDone,
      driverPages: scan.driverPages,
      locationPages: scan.locationPages,
      existingPages: scan.existingPages,
      candidateCount: scan.candidateTourIds.size,
      candidatesReconciled,
    };
  } catch (error) {
    if (apply) await finishBackfillRun({ statusRef, runId, state: 'error' });
    throw error;
  }
};

/** Paginated, repeatable backfill. Dry-run is the default; apply must be explicit. */
const runCoachTrackingBackfill = async ({
  db,
  apply = false,
  dryRun = !apply,
  pageSize = PAGE_SIZE_DEFAULT,
  maxPages = Number.POSITIVE_INFINITY,
  concurrency = BATCH_CONCURRENCY,
  onProgress = () => {},
  runId = randomUUID(),
} = {}) => {
  if (!db?.ref) throw new TypeError('A Realtime Database instance is required');
  if (apply && dryRun) throw new TypeError('Choose apply or dry-run, not both');
  const settings = normalizeBackfillSettings({ pageSize, concurrency });
  const statusRef = db.ref(COACH_TRACKING_STATUS_PATH);
  if (apply) await claimBackfillRunLock({ statusRef, runId });
  return executeCoachTrackingBackfill({
    db, apply, settings, maxPages, runId, statusRef, onProgress,
  });
};

module.exports = {
  ...tourFieldTriggers,
  projectCoachTrackingDriverCurrentTour,
  projectCoachTrackingDriverName,
  projectCoachTrackingLocation,
  readAssignedDrivers,
  readDriverPage,
  readExistingCoachTrackingPage,
  readLocationPage,
  reconcileCoachTrackingTour,
  runCoachTrackingBackfill,
};
