'use strict';

// @ts-check

const {
  onValueCreated,
  onValueDeleted,
  onValueWritten,
} = require('firebase-functions/v2/database');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { snapshotEntriesInQueryOrder } = require('../../infrastructure/database/rtdbQueryOrder');
const {
  DASHBOARD_ROOT,
  DASHBOARD_SCHEMA_VERSION,
  BROADCAST_RETENTION_MS,
  MAX_ASSIGNED_DRIVERS,
  buildRecentBroadcastProjection,
  buildSafetyAttentionProjection,
  buildTourProjection,
  countManifestBooking,
} = require('./dashboardProjection');
const {
  acquireCountLock,
  commitCompareSafeProjection,
  commitCompareSafePublicProjection,
  commitSummaryDomain,
  eventOrder,
  mapWithConcurrency,
  readValue,
  reconcileAggregateContribution,
  releaseCountLock,
} = require('./dashboardProjectionState');
const {
  dashboardDayKey,
  dashboardWindowDayKeys,
  publishDashboardWindowSummary,
  reconcileTourDaySummary,
  recomputeTourSummaryDomains,
  tourSummaryShardId,
} = require('./dashboardTourSummaries');

const REGION = 'europe-west1';
const INSTANCE = 'loch-lomond-travel-default-rtdb';
const DRIVER_READ_CONCURRENCY = 5;
const BROADCAST_PRUNE_LIMIT = 20;
const BROADCAST_WINDOW_PAGE_SIZE = 100;
const BROADCAST_SCHEDULED_PRUNE_PAGES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const DASHBOARD_TIME_ZONE = 'Europe/London';

const functionOptions = Object.freeze({
  region: REGION,
  instance: INSTANCE,
  retry: true,
  maxInstances: 20,
});

const readTourSource = async ({ db, tourId, instrumentation }) => {
  const scalarFields = [
    'tourCode', 'name', 'startDate', 'startDateEpochMs', 'endDateEpochMs',
    'isActive', 'currentParticipants', 'maxParticipants', 'driverName',
  ];
  const values = await Promise.all([
    ...scalarFields.map((field) => readValue(db, `tours/${tourId}/${field}`, instrumentation)),
    readValue(db, `${DASHBOARD_ROOT}/internal/participant_summaries/${tourId}`, instrumentation),
    readValue(db, `${DASHBOARD_ROOT}/internal/manifest_summaries/${tourId}`, instrumentation),
    readValue(db, `tour_manifests/${tourId}/assigned_drivers`, instrumentation),
    readValue(db, `tour_manifests/${tourId}/assigned_driver_codes`, instrumentation),
    readValue(db, `${DASHBOARD_ROOT}/internal/driver_tour_assignments/${tourId}`, instrumentation),
  ]);
  const tour = Object.fromEntries(scalarFields.map((field, index) => [field, values[index]]));
  const offset = scalarFields.length;
  const participantSummary = values[offset] || {};
  const manifestSummary = values[offset + 1] || {};
  const assignedDrivers = values[offset + 2] || {};
  const assignedDriverCodes = values[offset + 3] || {};
  const legacyDriverAssignments = values[offset + 4] || {};
  const assignedDriverIds = [...new Set([
    ...Object.entries(assignedDrivers).filter(([, assigned]) => Boolean(assigned)).map(([driverId]) => driverId),
    ...Object.keys(assignedDriverCodes),
    ...Object.keys(legacyDriverAssignments),
  ])].filter(isValidFirebaseKey).sort().slice(0, MAX_ASSIGNED_DRIVERS);
  const driverEntries = await mapWithConcurrency(assignedDriverIds, DRIVER_READ_CONCURRENCY, async (driverId) => [
    driverId,
    await readValue(db, `drivers/${driverId}/name`, instrumentation),
  ]);
  return {
    exists: scalarFields.some((field) => tour[field] !== null && tour[field] !== undefined),
    tour,
    participantCount: Number(participantSummary.count || 0),
    manifestPassengerCount: Number(manifestSummary.count || 0),
    assignment: {
      assignedDrivers: { ...legacyDriverAssignments, ...assignedDrivers },
      assignedDriverCodes,
    },
    driverProfiles: Object.fromEntries(driverEntries.map(([driverId, name]) => [
      driverId,
      { name: name || legacyDriverAssignments?.[driverId]?.name },
    ])),
  };
};

// Compare-safe commit, crash-recovery completion and the two summary families intentionally share one tour lock.
// eslint-disable-next-line complexity
const recomputeTourProjection = async ({ db, tourId, order, instrumentation }) => {
  if (!isValidFirebaseKey(tourId)) return { applied: false, reason: 'invalid_tour' };
  const owner = `tour-projection:${order.sourceEventId || order.sourceEventAtMs}`;
  const lockPath = `${DASHBOARD_ROOT}/internal/count_locks/tour_projection/${tourId}`;
  if (!(await acquireCountLock({ db, lockPath, owner }))) {
    const error = new Error('Dashboard tour projection is already in progress');
    error.code = 'DASHBOARD_TOUR_PROJECTION_LOCKED';
    throw error;
  }
  if (instrumentation) instrumentation.toursRecomputed = Number(instrumentation.toursRecomputed || 0) + 1;
  try {
    const source = await readTourSource({ db, tourId, instrumentation });
    const projection = source.exists ? buildTourProjection({ tourId, ...source }) : null;
    const commit = await commitCompareSafeProjection({
      projectionRef: db.ref(`${DASHBOARD_ROOT}/tours/${tourId}`),
      projection,
      identity: { tourId },
      order,
    });
    const currentProjection = commit.current;
    const completionPath = `${DASHBOARD_ROOT}/internal/tour_projection_completion/${tourId}`;
    const completion = await readValue(db, completionPath, instrumentation);
    if (completion?.projectionRevision === currentProjection?.projectionRevision
      && completion?.sourceFingerprint === currentProjection?.sourceFingerprint) {
      if (instrumentation) instrumentation.tourAggregateRecomputationsSkipped = Number(
        instrumentation.tourAggregateRecomputationsSkipped || 0,
      ) + 1;
      return { ...commit, aggregateRecomputed: false };
    }
    await recomputeTourSummaryDomains({ db, tourId, order, instrumentation });
    await db.ref(completionPath).set({
      schemaVersion: DASHBOARD_SCHEMA_VERSION,
      projectionRevision: Number(currentProjection?.projectionRevision || 0),
      sourceFingerprint: currentProjection?.sourceFingerprint || 'deleted',
      completedAtMs: Date.now(),
    });
    return { ...commit, aggregateRecomputed: true };
  } finally {
    await releaseCountLock({ db, lockPath, owner });
  }
};

const publishSafetySummary = async ({ db, eventId, order }) => {
  const summary = await reconcileAggregateContribution({
    db,
    type: 'safety',
    scopeId: 'global',
    memberId: eventId,
    owner: `safety:${order.sourceEventId || order.sourceEventAtMs}`,
    nowMs: order.sourceEventAtMs,
    aggregatePath: `${DASHBOARD_ROOT}/internal/safety_summary`,
    loadCurrentContribution: async () => (
      await readValue(db, `${DASHBOARD_ROOT}/safety_attention/${eventId}`)
        ? { safetyAttentionAlerts: 1 }
        : {}
    ),
  });
  await commitSummaryDomain({
    db,
    domain: 'safety',
    revision: summary.revision,
    nowMs: order.sourceEventAtMs,
    fields: { safetyAttentionAlerts: Number(summary.safetyAttentionAlerts || 0) },
  });
};

const publishBroadcastSummary = async ({ db, broadcastId, tourId, order }) => {
  const tourSummary = await reconcileAggregateContribution({
    db,
    type: 'broadcast',
    scopeId: tourId,
    memberId: broadcastId,
    owner: `broadcast:${order.sourceEventId || order.sourceEventAtMs}`,
    nowMs: order.sourceEventAtMs,
    aggregatePath: `${DASHBOARD_ROOT}/internal/broadcast_summaries/${tourId}`,
    loadCurrentContribution: async () => (
      await readValue(db, `broadcasts/${tourId}/${broadcastId}`)
        ? { count: 1 }
        : {}
    ),
  });
  const summary = await reconcileAggregateContribution({
    db,
    type: 'broadcast_tour',
    scopeId: 'global',
    memberId: tourId,
    owner: `broadcast-tour:${order.sourceEventId || order.sourceEventAtMs}`,
    nowMs: order.sourceEventAtMs,
    aggregatePath: `${DASHBOARD_ROOT}/internal/broadcast_summary`,
    loadCurrentContribution: async () => ({
      broadcastTotalCount: Number(tourSummary.count || 0),
      broadcastTourCount: Number(tourSummary.count || 0) > 0 ? 1 : 0,
    }),
  });
  const newestSnapshot = await db.ref(`${DASHBOARD_ROOT}/recent_broadcasts`)
    .orderByChild('createdAtMs').limitToLast(1).once('value');
  const newest = Object.values(newestSnapshot.val() || {})[0];
  await commitSummaryDomain({
    db,
    domain: 'broadcast',
    revision: summary.revision,
    nowMs: order.sourceEventAtMs,
    fields: {
      broadcastTotalCount: Number(summary.broadcastTotalCount || 0),
      broadcastTourCount: Number(summary.broadcastTourCount || 0),
      lastBroadcastAtMs: Number(newest?.createdAtMs || 0) || null,
    },
  });
};

const pruneExpiredBroadcastProjections = async ({ db, nowMs, instrumentation }) => {
  if (instrumentation) instrumentation.broadcastPruneQueries = Number(instrumentation.broadcastPruneQueries || 0) + 1;
  const snapshot = await db.ref(`${DASHBOARD_ROOT}/recent_broadcasts`)
    .orderByChild('createdAtMs')
    .endAt(nowMs - BROADCAST_RETENTION_MS - 1)
    .limitToFirst(BROADCAST_PRUNE_LIMIT)
    .once('value');
  const entries = Object.entries(snapshot.val() || {});
  for (const [broadcastId, row] of entries) {
    const order = { sourceEventAtMs: nowMs, sourceEventId: `retention:${broadcastId}` };
    await commitCompareSafePublicProjection({
      projectionRef: db.ref(`${DASHBOARD_ROOT}/recent_broadcasts/${broadcastId}`),
      watermarkRef: db.ref(`${DASHBOARD_ROOT}/internal/watermarks/recent_broadcasts/${broadcastId}`),
      projection: null,
      order,
      refreshProjection: async () => null,
    });
    await publishBroadcastSummary({
      db,
      broadcastId,
      tourId: row?.tourId,
      projection: null,
      order,
    });
  }
  return entries.length;
};

const countRecentBroadcastWindow = async ({ db, nowMs = Date.now(), instrumentation }) => {
  let cursor = null;
  let count = 0;
  do {
    let query = db.ref(`${DASHBOARD_ROOT}/recent_broadcasts`)
      .orderByChild('createdAtMs')
      .startAt(nowMs - DAY_MS)
      .endAt(nowMs);
    if (cursor) query = query.startAfter(cursor.createdAtMs, cursor.key);
    if (instrumentation) instrumentation.broadcastWindowQueries = Number(instrumentation.broadcastWindowQueries || 0) + 1;
    const snapshot = await query.limitToFirst(BROADCAST_WINDOW_PAGE_SIZE + 1).once('value');
    const entries = snapshotEntriesInQueryOrder(snapshot);
    const selected = entries.slice(0, BROADCAST_WINDOW_PAGE_SIZE);
    count += selected.length;
    const last = selected.at(-1);
    cursor = entries.length > BROADCAST_WINDOW_PAGE_SIZE && last
      ? { key: last[0], createdAtMs: Number(last[1]?.createdAtMs || 0) }
      : null;
  } while (cursor);
  return count;
};

const refreshDashboardBroadcastWindowSummary = async ({ db, nowMs = Date.now(), instrumentation }) => {
  const broadcastLast24hCount = await countRecentBroadcastWindow({ db, nowMs, instrumentation });
  await commitSummaryDomain({
    db,
    domain: 'broadcastWindow',
    revision: nowMs,
    nowMs,
    fields: { broadcastLast24hCount },
  });
  return { broadcastLast24hCount };
};

const refreshDashboardTimeWindows = async ({ db, nowMs = Date.now(), instrumentation }) => {
  const [tourWindow, broadcastWindow] = await Promise.all([
    publishDashboardWindowSummary({ db, nowMs, instrumentation }),
    refreshDashboardBroadcastWindowSummary({ db, nowMs, instrumentation }),
  ]);
  let pruned = 0;
  for (let page = 0; page < BROADCAST_SCHEDULED_PRUNE_PAGES; page += 1) {
    const removed = await pruneExpiredBroadcastProjections({ db, nowMs, instrumentation });
    pruned += removed;
    if (removed < BROADCAST_PRUNE_LIMIT) break;
  }
  return { ...tourWindow, ...broadcastWindow, pruned };
};

const handleManifestBookingWrite = async ({ db, event, instrumentation }) => {
  const { tourId } = event.params;
  if (!isValidFirebaseKey(tourId)) return null;
  const order = eventOrder(event);
  if (instrumentation) instrumentation.manifestBookingsEvaluated = Number(instrumentation.manifestBookingsEvaluated || 0) + 1;
  await reconcileAggregateContribution({
    db,
    type: 'manifest',
    scopeId: tourId,
    memberId: event.params.bookingRef,
    owner: order.sourceEventId || `${order.sourceEventAtMs}`,
    nowMs: order.sourceEventAtMs,
    aggregatePath: `${DASHBOARD_ROOT}/internal/manifest_summaries/${tourId}`,
    loadCurrentContribution: async () => {
      const booking = await readValue(db, `tour_manifests/${tourId}/bookings/${event.params.bookingRef}`, instrumentation);
      const count = countManifestBooking(booking);
      return count > 0 ? { count } : {};
    },
  });
  await recomputeTourProjection({ db, tourId, order, instrumentation });
  return null;
};

const handleParticipantWrite = async ({ db, event, instrumentation }) => {
  const { tourId } = event.params;
  if (!isValidFirebaseKey(tourId)) return null;
  const order = eventOrder(event);
  await reconcileAggregateContribution({
    db,
    type: 'participant',
    scopeId: tourId,
    memberId: event.params.authUid,
    owner: order.sourceEventId || `${order.sourceEventAtMs}`,
    nowMs: order.sourceEventAtMs,
    aggregatePath: `${DASHBOARD_ROOT}/internal/participant_summaries/${tourId}`,
    loadCurrentContribution: async () => {
      const participant = await readValue(db, `tours/${tourId}/participants/${event.params.authUid}`, instrumentation);
      return participant ? { count: 1 } : {};
    },
  });
  await recomputeTourProjection({ db, tourId, order, instrumentation });
  return null;
};

const assignedTourIds = (driver) => [...new Set([
  typeof driver?.currentTourId === 'string' ? driver.currentTourId.trim() : '',
  ...Object.entries(driver?.assignments && typeof driver.assignments === 'object' ? driver.assignments : {})
    .filter(([, assigned]) => Boolean(assigned)).map(([tourId]) => tourId),
])].filter(isValidFirebaseKey);

const driverHasAssignment = (driver) => assignedTourIds(driver).length > 0;

const handleDriverWrite = async ({ db, event, instrumentation }) => {
  const driverId = event.params.driverId;
  if (!isValidFirebaseKey(driverId)) return null;
  const order = eventOrder(event);
  const owner = `driver-state:${order.sourceEventId || order.sourceEventAtMs}`;
  const lockPath = `${DASHBOARD_ROOT}/internal/count_locks/driver_state/${driverId}`;
  if (!(await acquireCountLock({ db, lockPath, owner }))) {
    const error = new Error('Dashboard driver reconciliation is already in progress');
    error.code = 'DASHBOARD_DRIVER_LOCKED';
    throw error;
  }
  let toursToRecompute = [];
  try {
    const [after, priorState] = await Promise.all([
      readValue(db, `drivers/${driverId}`, instrumentation),
      readValue(db, `${DASHBOARD_ROOT}/internal/driver_assignment_state/${driverId}`, instrumentation),
    ]);
    const beforeTours = Object.keys(priorState?.tourIds || {}).filter(isValidFirebaseKey);
    const afterTours = assignedTourIds(after);
    const beforeTourSet = new Set(beforeTours);
    const afterTourSet = new Set(afterTours);
    const currentName = typeof after?.name === 'string' ? after.name.slice(0, 120) : driverId;
    const nameChanged = priorState?.name !== currentName;
    const driverSummary = await reconcileAggregateContribution({
      db,
      type: 'driver',
      scopeId: 'global',
      memberId: driverId,
      owner: order.sourceEventId || `${order.sourceEventAtMs}`,
      nowMs: order.sourceEventAtMs,
      aggregatePath: `${DASHBOARD_ROOT}/internal/driver_summary`,
      loadCurrentContribution: async () => (after ? {
        totalDrivers: 1,
        assignedDrivers: driverHasAssignment(after) ? 1 : 0,
      } : {}),
    });
    const totalDrivers = Number(driverSummary.totalDrivers || 0);
    const assignedDrivers = Number(driverSummary.assignedDrivers || 0);
    await commitSummaryDomain({
      db,
      domain: 'driver',
      revision: driverSummary.revision,
      nowMs: order.sourceEventAtMs,
      fields: {
        totalDrivers,
        assignedDrivers,
        availableDrivers: Math.max(0, totalDrivers - assignedDrivers),
      },
    });
    const assignmentUpdates = {};
    beforeTours.filter((tourId) => !afterTourSet.has(tourId)).forEach((tourId) => {
      assignmentUpdates[`${DASHBOARD_ROOT}/internal/driver_tour_assignments/${tourId}/${driverId}`] = null;
    });
    afterTours.filter((tourId) => nameChanged || !beforeTourSet.has(tourId)).forEach((tourId) => {
      assignmentUpdates[`${DASHBOARD_ROOT}/internal/driver_tour_assignments/${tourId}/${driverId}`] = {
        schemaVersion: DASHBOARD_SCHEMA_VERSION,
        name: currentName,
        updatedAtMs: order.sourceEventAtMs,
      };
    });
    assignmentUpdates[`${DASHBOARD_ROOT}/internal/driver_assignment_state/${driverId}`] = after ? {
      schemaVersion: DASHBOARD_SCHEMA_VERSION,
      name: currentName,
      tourIds: Object.fromEntries(afterTours.map((tourId) => [tourId, true])),
      updatedAtMs: Math.max(Number(priorState?.updatedAtMs || 0), order.sourceEventAtMs),
    } : null;
    await db.ref().update(assignmentUpdates);
    const changedTours = [...new Set([
      ...beforeTours.filter((tourId) => !afterTourSet.has(tourId)),
      ...afterTours.filter((tourId) => !beforeTourSet.has(tourId)),
    ])];
    toursToRecompute = nameChanged ? [...new Set([...beforeTours, ...afterTours])] : changedTours;
  } finally {
    await releaseCountLock({ db, lockPath, owner });
  }
  for (const tourId of toursToRecompute) {
    await recomputeTourProjection({ db, tourId, order, instrumentation });
  }
  return null;
};

const handleSafetyWrite = async ({ db, event }) => {
  const { tourId, eventId } = event.params;
  if (!isValidFirebaseKey(tourId) || !isValidFirebaseKey(eventId)) return null;
  const readProjection = async () => {
    const alert = await readValue(db, `tours/${tourId}/safetyAlerts/${eventId}`);
    return buildSafetyAttentionProjection({ eventId, tourId, alert });
  };
  const projection = await readProjection();
  const order = eventOrder(event);
  await commitCompareSafePublicProjection({
    projectionRef: db.ref(`${DASHBOARD_ROOT}/safety_attention/${eventId}`),
    watermarkRef: db.ref(`${DASHBOARD_ROOT}/internal/watermarks/safety_attention/${eventId}`),
    projection,
    order,
    refreshProjection: readProjection,
  });
  await publishSafetySummary({ db, eventId, projection, order });
  return null;
};

const handleBroadcastWrite = async ({ db, event, instrumentation }) => {
  const { tourId, broadcastId } = event.params;
  if (!isValidFirebaseKey(tourId) || !isValidFirebaseKey(broadcastId)) return null;
  const readProjection = async () => {
    const broadcast = await readValue(db, `broadcasts/${tourId}/${broadcastId}`);
    return buildRecentBroadcastProjection({ broadcastId, tourId, broadcast, nowMs: Date.now() });
  };
  const projection = await readProjection();
  const order = eventOrder(event);
  await commitCompareSafePublicProjection({
    projectionRef: db.ref(`${DASHBOARD_ROOT}/recent_broadcasts/${broadcastId}`),
    watermarkRef: db.ref(`${DASHBOARD_ROOT}/internal/watermarks/recent_broadcasts/${broadcastId}`),
    projection,
    order,
    refreshProjection: readProjection,
  });
  await publishBroadcastSummary({ db, broadcastId, tourId, projection, order });
  await pruneExpiredBroadcastProjections({ db, nowMs: Date.now(), instrumentation });
  return null;
};

const withDatabase = (handler) => (event) => handler({ db: admin.database(), event });
const tourHandler = withDatabase(({ db, event }) => recomputeTourProjection({
  db, tourId: event.params.tourId, order: eventOrder(event),
}));

const projectDashboardTourCreated = onValueCreated(
  { ...functionOptions, ref: '/tours/{tourId}' }, tourHandler,
);
const projectDashboardTourDeleted = onValueDeleted(
  { ...functionOptions, ref: '/tours/{tourId}' }, tourHandler,
);

const tourFieldDefinitions = Object.freeze({
  projectDashboardTourName: 'name',
  projectDashboardTourCode: 'tourCode',
  projectDashboardTourStartDate: 'startDate',
  projectDashboardTourStartIndex: 'startDateEpochMs',
  projectDashboardTourEndIndex: 'endDateEpochMs',
  projectDashboardTourActive: 'isActive',
  projectDashboardTourPassengerScalar: 'currentParticipants',
  projectDashboardTourCapacity: 'maxParticipants',
  projectDashboardTourDriverName: 'driverName',
  projectDashboardTourAssignmentRevision: 'driverAssignmentRevision',
});

const tourFieldTriggers = Object.fromEntries(Object.entries(tourFieldDefinitions).map(([name, field]) => [
  name,
  onValueWritten({ ...functionOptions, ref: `/tours/{tourId}/${field}` }, tourHandler),
]));

const projectDashboardManifestBooking = onValueWritten(
  { ...functionOptions, ref: '/tour_manifests/{tourId}/bookings/{bookingRef}' },
  withDatabase(handleManifestBookingWrite),
);
const projectDashboardManifestAssignment = onValueWritten(
  { ...functionOptions, ref: '/tour_manifests/{tourId}/assigned_drivers/{driverId}' },
  tourHandler,
);
const projectDashboardManifestAssignmentCode = onValueWritten(
  { ...functionOptions, ref: '/tour_manifests/{tourId}/assigned_driver_codes/{driverId}' },
  tourHandler,
);
const projectDashboardParticipant = onValueWritten(
  { ...functionOptions, ref: '/tours/{tourId}/participants/{authUid}' },
  withDatabase(handleParticipantWrite),
);
const projectDashboardDriver = onValueWritten(
  { ...functionOptions, ref: '/drivers/{driverId}' },
  withDatabase(handleDriverWrite),
);
const projectDashboardSafetyAttention = onValueWritten(
  { ...functionOptions, ref: '/tours/{tourId}/safetyAlerts/{eventId}' },
  withDatabase(handleSafetyWrite),
);
const projectDashboardRecentBroadcast = onValueWritten(
  { ...functionOptions, ref: '/broadcasts/{tourId}/{broadcastId}' },
  withDatabase(handleBroadcastWrite),
);
const refreshDashboardTimeWindowsScheduled = onSchedule({
  schedule: 'every 15 minutes',
  timeZone: DASHBOARD_TIME_ZONE,
  region: REGION,
  retryCount: 3,
  maxInstances: 1,
}, async () => refreshDashboardTimeWindows({ db: admin.database() }));

module.exports = {
  ...tourFieldTriggers,
  acquireCountLock,
  commitCompareSafeProjection,
  commitCompareSafePublicProjection,
  commitSummaryDomain,
  countRecentBroadcastWindow,
  dashboardDayKey,
  dashboardWindowDayKeys,
  handleBroadcastWrite,
  handleDriverWrite,
  handleManifestBookingWrite,
  handleParticipantWrite,
  handleSafetyWrite,
  mapWithConcurrency,
  pruneExpiredBroadcastProjections,
  publishDashboardWindowSummary,
  publishBroadcastSummary,
  publishSafetySummary,
  projectDashboardManifestAssignmentCode,
  projectDashboardDriver,
  projectDashboardManifestAssignment,
  projectDashboardManifestBooking,
  projectDashboardParticipant,
  projectDashboardRecentBroadcast,
  projectDashboardSafetyAttention,
  projectDashboardTourCreated,
  projectDashboardTourDeleted,
  readTourSource,
  reconcileAggregateContribution,
  reconcileTourDaySummary,
  refreshDashboardBroadcastWindowSummary,
  refreshDashboardTimeWindows,
  refreshDashboardTimeWindowsScheduled,
  recomputeTourProjection,
  tourSummaryShardId,
};
