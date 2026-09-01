#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const { selectSnapshotPage } = require('../src/infrastructure/database/rtdbQueryOrder');
const {
  BROADCAST_RETENTION_MS,
  DASHBOARD_ROOT,
  DASHBOARD_SCHEMA_VERSION,
  MAX_ASSIGNED_DRIVERS,
  buildRecentBroadcastProjection,
  buildSafetyAttentionProjection,
  countManifestBooking,
  fingerprint,
} = require('../src/domains/admin-dashboard/dashboardProjection');
const {
  commitCompareSafePublicProjection,
  commitSummaryDomain,
  publishBroadcastSummary,
  publishSafetySummary,
  recomputeTourProjection,
} = require('../src/domains/admin-dashboard/dashboardProjectionFunctions');

const PROGRESS_PATH = 'admin_dashboard_migrations/projection_v1';
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const DEFAULT_MEMBER_PAGE_SIZE = 250;
const MAX_MEMBER_PAGE_SIZE = 500;
const DEFAULT_CONCURRENCY = 5;
const MAX_CONCURRENCY = 10;

const readArg = (argv, name) => (argv.find((arg) => arg.startsWith(`--${name}=`)) || '')
  .slice(name.length + 3).trim();

const boundedIntegerArg = (argv, name, fallback, maximum) => {
  const value = Number(readArg(argv, name));
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
};

const parseArgs = (argv = []) => ({
  apply: argv.includes('--apply'),
  restart: argv.includes('--restart'),
  confirmProject: readArg(argv, 'confirm-project'),
  afterTour: readArg(argv, 'after-tour'),
  pageSize: boundedIntegerArg(argv, 'page-size', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  memberPageSize: boundedIntegerArg(argv, 'member-page-size', DEFAULT_MEMBER_PAGE_SIZE, MAX_MEMBER_PAGE_SIZE),
  concurrency: boundedIntegerArg(argv, 'concurrency', DEFAULT_CONCURRENCY, MAX_CONCURRENCY),
});

const cursorHash = (cursor) => cursor
  ? createHash('sha256').update(cursor).digest('hex').slice(0, 16)
  : null;

const mapWithConcurrency = async (items, limit, mapper) => {
  const output = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
};

const readKeyPage = async ({ sourceRef, afterKey, pageSize }) => {
  let query = sourceRef.orderByKey();
  if (afterKey) query = query.startAfter(afterKey);
  const snapshot = await query.limitToFirst(pageSize + 1).once('value');
  const page = selectSnapshotPage(snapshot, pageSize);
  return {
    entries: page.entries,
    nextCursor: page.hasMore ? page.lastKey : null,
  };
};

const writeContributionPage = async ({ db, path, entries, contributionFor, nowMs, generation, concurrency }) => {
  await mapWithConcurrency(entries, concurrency, async ([memberId, value]) => {
    const contribution = contributionFor(value);
    const candidate = Object.keys(contribution).length
      ? {
        ...contribution,
        schemaVersion: DASHBOARD_SCHEMA_VERSION,
        updatedAtMs: nowMs,
        backfillGeneration: generation,
      }
      : null;
    await db.ref(`${path}/${fingerprint({ memberId })}`).transaction((current) => (
      Number(current?.updatedAtMs || 0) > nowMs ? current : candidate
    ), undefined, false);
  });
};

const pruneStaleContributionRows = async ({ db, path, memberPageSize, nowMs, generation, concurrency }) => {
  let afterKey = '';
  let page;
  do {
    page = await readKeyPage({ sourceRef: db.ref(path), afterKey, pageSize: memberPageSize });
    await mapWithConcurrency(page.entries, concurrency, async ([memberHash]) => {
      await db.ref(`${path}/${memberHash}`).transaction((current) => {
        if (!current || current.backfillGeneration === generation || Number(current.updatedAtMs || 0) > nowMs) return current;
        return null;
      }, undefined, false);
    });
    afterKey = page.nextCursor || '';
  } while (page.nextCursor);
};

const setBackfillSummary = (db, path, candidate, nowMs) => db.ref(path).transaction((current) => (
  Number(current?.updatedAtMs || 0) > nowMs
    ? current
    : { ...candidate, revision: Math.max(Number(candidate.revision || 0), Number(current?.revision || 0) + 1) }
), undefined, false);

const scanMemberSummary = async ({
  db,
  sourcePath,
  contributionPath,
  memberPageSize,
  contributionFor,
  apply,
  nowMs,
  concurrency,
}) => {
  const generation = fingerprint({ sourcePath, nowMs });
  let afterKey = '';
  let count = 0;
  let recordsScanned = 0;
  let page;
  do {
    page = await readKeyPage({ sourceRef: db.ref(sourcePath), afterKey, pageSize: memberPageSize });
    recordsScanned += page.entries.length;
    page.entries.forEach(([, value]) => { count += Number(contributionFor(value).count || 0); });
    if (apply) {
      await writeContributionPage({
        db, path: contributionPath, entries: page.entries, contributionFor, nowMs, generation, concurrency,
      });
    }
    afterKey = page.nextCursor || '';
  } while (page.nextCursor);
  if (apply) {
    await pruneStaleContributionRows({
      db, path: contributionPath, memberPageSize, nowMs, generation, concurrency,
    });
  }
  return { count, recordsScanned };
};

const backfillDrivers = async ({ db, options, nowMs }) => {
  const contributionPath = `${DASHBOARD_ROOT}/internal/count_contributions/driver/global`;
  const generation = fingerprint({ sourcePath: 'drivers', nowMs });
  let afterKey = '';
  let totalDrivers = 0;
  let assignedDrivers = 0;
  let page;
  do {
    page = await readKeyPage({ sourceRef: db.ref('drivers'), afterKey, pageSize: options.memberPageSize });
    const updates = {};
    page.entries.forEach(([driverId, driver]) => {
      const tourIds = [...new Set([
        typeof driver?.currentTourId === 'string' ? driver.currentTourId.trim() : '',
        ...Object.entries(driver?.assignments && typeof driver.assignments === 'object' ? driver.assignments : {})
          .filter(([, assigned]) => Boolean(assigned)).map(([tourId]) => tourId),
      ].filter(Boolean))];
      totalDrivers += 1;
      assignedDrivers += Number(tourIds.length > 0);
      updates[`${DASHBOARD_ROOT}/internal/driver_assignment_state/${driverId}`] = {
        schemaVersion: DASHBOARD_SCHEMA_VERSION,
        name: typeof driver?.name === 'string' ? driver.name.slice(0, 120) : driverId,
        tourIds: Object.fromEntries(tourIds.map((tourId) => [tourId, true])),
        updatedAtMs: nowMs,
      };
      tourIds.slice(0, MAX_ASSIGNED_DRIVERS).forEach((tourId) => {
        updates[`${DASHBOARD_ROOT}/internal/driver_tour_assignments/${tourId}/${driverId}`] = {
          schemaVersion: DASHBOARD_SCHEMA_VERSION,
          name: typeof driver?.name === 'string' ? driver.name.slice(0, 120) : driverId,
          updatedAtMs: nowMs,
        };
      });
    });
    if (options.apply) {
      await writeContributionPage({
        db,
        path: contributionPath,
        entries: page.entries,
        contributionFor: (driver) => {
          const assigned = Boolean(
            (typeof driver?.currentTourId === 'string' && driver.currentTourId.trim())
            || Object.values(driver?.assignments && typeof driver.assignments === 'object' ? driver.assignments : {}).some(Boolean),
          );
          return { totalDrivers: 1, assignedDrivers: assigned ? 1 : 0 };
        },
        nowMs,
        generation,
        concurrency: options.concurrency,
      });
      if (Object.keys(updates).length) await db.ref().update(updates);
    }
    afterKey = page.nextCursor || '';
  } while (page.nextCursor);
  if (options.apply) {
    await pruneStaleContributionRows({
      db,
      path: contributionPath,
      memberPageSize: options.memberPageSize,
      nowMs,
      generation,
      concurrency: options.concurrency,
    });
    const driverSummaryResult = await setBackfillSummary(db, `${DASHBOARD_ROOT}/internal/driver_summary`, {
      schemaVersion: DASHBOARD_SCHEMA_VERSION,
      totalDrivers,
      assignedDrivers,
      revision: 1,
      updatedAtMs: nowMs,
    }, nowMs);
    const driverSummary = driverSummaryResult.snapshot?.val?.() || {};
    await commitSummaryDomain({
      db,
      domain: 'driver',
      revision: driverSummary.revision,
      nowMs,
      fields: {
        totalDrivers: Number(driverSummary.totalDrivers || 0),
        assignedDrivers: Number(driverSummary.assignedDrivers || 0),
        availableDrivers: Math.max(0,
          Number(driverSummary.totalDrivers || 0) - Number(driverSummary.assignedDrivers || 0)),
      },
    });
  }
  return { totalDrivers, assignedDrivers };
};

const backfillSafety = async ({ db, tourId, options, nowMs }) => {
  let afterKey = '';
  let projected = 0;
  let page;
  do {
    page = await readKeyPage({
      sourceRef: db.ref(`tours/${tourId}/safetyAlerts`), afterKey, pageSize: options.memberPageSize,
    });
    for (const [eventId, alert] of page.entries) {
      const projection = buildSafetyAttentionProjection({ eventId, tourId, alert });
      projected += Number(Boolean(projection));
      if (options.apply) {
        const order = { sourceEventAtMs: nowMs, sourceEventId: `backfill:safety:${eventId}` };
        await commitCompareSafePublicProjection({
          projectionRef: db.ref(`${DASHBOARD_ROOT}/safety_attention/${eventId}`),
          watermarkRef: db.ref(`${DASHBOARD_ROOT}/internal/watermarks/safety_attention/${eventId}`),
          projection,
          order,
          refreshProjection: async () => buildSafetyAttentionProjection({
            eventId, tourId, alert: (await db.ref(`tours/${tourId}/safetyAlerts/${eventId}`).once('value')).val(),
          }),
        });
        await publishSafetySummary({ db, eventId, projection, order });
      }
    }
    afterKey = page.nextCursor || '';
  } while (page.nextCursor);
  return projected;
};

const backfillBroadcasts = async ({ db, tourId, options, nowMs }) => {
  let afterKey = '';
  let projected = 0;
  let page;
  do {
    page = await readKeyPage({ sourceRef: db.ref(`broadcasts/${tourId}`), afterKey, pageSize: options.memberPageSize });
    for (const [broadcastId, broadcast] of page.entries) {
      const projection = buildRecentBroadcastProjection({ broadcastId, tourId, broadcast, nowMs });
      projected += Number(Boolean(projection));
      if (options.apply) {
        const order = { sourceEventAtMs: nowMs, sourceEventId: `backfill:broadcast:${broadcastId}` };
        await commitCompareSafePublicProjection({
          projectionRef: db.ref(`${DASHBOARD_ROOT}/recent_broadcasts/${broadcastId}`),
          watermarkRef: db.ref(`${DASHBOARD_ROOT}/internal/watermarks/recent_broadcasts/${broadcastId}`),
          projection,
          order,
          refreshProjection: async () => buildRecentBroadcastProjection({
            broadcastId,
            tourId,
            broadcast: (await db.ref(`broadcasts/${tourId}/${broadcastId}`).once('value')).val(),
            nowMs: Date.now(),
          }),
        });
        await publishBroadcastSummary({ db, broadcastId, tourId, projection, order });
      }
    }
    afterKey = page.nextCursor || '';
  } while (page.nextCursor);
  return projected;
};

const backfillTour = async ({ db, tourId, options, nowMs }) => {
  const manifest = await scanMemberSummary({
    db,
    sourcePath: `tour_manifests/${tourId}/bookings`,
    contributionPath: `${DASHBOARD_ROOT}/internal/count_contributions/manifest/${tourId}`,
    memberPageSize: options.memberPageSize,
    contributionFor: (booking) => {
      const count = countManifestBooking(booking);
      return count > 0 ? { count } : {};
    },
    apply: options.apply,
    nowMs,
    concurrency: options.concurrency,
  });
  const participants = await scanMemberSummary({
    db,
    sourcePath: `tours/${tourId}/participants`,
    contributionPath: `${DASHBOARD_ROOT}/internal/count_contributions/participant/${tourId}`,
    memberPageSize: options.memberPageSize,
    contributionFor: (participant) => (participant ? { count: 1 } : {}),
    apply: options.apply,
    nowMs,
    concurrency: options.concurrency,
  });
  if (options.apply) {
    await setBackfillSummary(db, `${DASHBOARD_ROOT}/internal/manifest_summaries/${tourId}`, {
      schemaVersion: DASHBOARD_SCHEMA_VERSION, count: manifest.count, revision: 1, updatedAtMs: nowMs,
    }, nowMs);
    await setBackfillSummary(db, `${DASHBOARD_ROOT}/internal/participant_summaries/${tourId}`, {
      schemaVersion: DASHBOARD_SCHEMA_VERSION, count: participants.count, revision: 1, updatedAtMs: nowMs,
    }, nowMs);
    await recomputeTourProjection({
      db, tourId, order: { sourceEventAtMs: nowMs, sourceEventId: `backfill:tour:${fingerprint({ tourId })}` },
    });
  }
  const [safetyRows, broadcastRows] = await Promise.all([
    backfillSafety({ db, tourId, options, nowMs }),
    backfillBroadcasts({ db, tourId, options, nowMs }),
  ]);
  return {
    manifestRows: manifest.recordsScanned,
    participantRows: participants.recordsScanned,
    safetyRows,
    broadcastRows,
  };
};

const backfillTourPage = async ({ db, entries, options, nowMs }) => {
  // Per-tour coordination and sharded summaries permit bounded parallel apply work.
  const results = await mapWithConcurrency(entries, options.concurrency, ([tourId]) => (
    backfillTour({ db, tourId, options, nowMs })
  ));
  return results.reduce((summary, result) => ({
    tours: summary.tours + 1,
    manifestRows: summary.manifestRows + result.manifestRows,
    participantRows: summary.participantRows + result.participantRows,
    safetyRows: summary.safetyRows + result.safetyRows,
    broadcastRows: summary.broadcastRows + result.broadcastRows,
  }), { tours: 0, manifestRows: 0, participantRows: 0, safetyRows: 0, broadcastRows: 0 });
};

const run = async ({ admin, options, nowMs = Date.now() }) => {
  const projectId = admin.app().options.projectId || process.env.GCLOUD_PROJECT || '';
  if (options.apply && (!projectId || options.confirmProject !== projectId)) {
    throw new Error(`Refusing apply: pass --confirm-project=${projectId || '<project-id>'}`);
  }
  if (options.apply && options.afterTour && !options.restart) {
    throw new Error('Refusing apply cursor override without explicit --restart');
  }
  const db = admin.database();
  const progress = options.apply
    ? ((await db.ref(PROGRESS_PATH).once('value')).val() || {})
    : {};
  if (options.apply && progress.status === 'complete' && !options.restart) {
    return { mode: 'apply', projectId, complete: true, alreadyComplete: true };
  }
  const drivers = progress.driversComplete && !options.restart
    ? { totalDrivers: Number(progress.totalDrivers || 0), assignedDrivers: Number(progress.assignedDrivers || 0) }
    : await backfillDrivers({ db, options, nowMs });
  let afterTour = options.afterTour || (!options.restart ? String(progress.lastTourCursor || '') : '');
  const pageStartCursor = afterTour;
  const progressRevision = Number(progress.revision || 0);
  let summary = { tours: 0, manifestRows: 0, participantRows: 0, safetyRows: 0, broadcastRows: 0 };
  let page;
  do {
    page = await readKeyPage({ sourceRef: db.ref('tours'), afterKey: afterTour, pageSize: options.pageSize });
    const pageSummary = await backfillTourPage({ db, entries: page.entries, options, nowMs });
    Object.keys(summary).forEach((key) => { summary[key] += pageSummary[key]; });
    afterTour = page.nextCursor || '';
  } while (!options.apply && page.nextCursor);
  const complete = !page.nextCursor;
  if (options.apply) {
    const progressResult = await db.ref(PROGRESS_PATH).transaction((current) => {
      if (Number(current?.revision || 0) !== progressRevision) return undefined;
      if (!options.restart && String(current?.lastTourCursor || '') !== pageStartCursor) return undefined;
      return {
        schemaVersion: DASHBOARD_SCHEMA_VERSION,
        revision: progressRevision + 1,
        status: complete ? 'complete' : 'running',
        driversComplete: true,
        totalDrivers: drivers.totalDrivers,
        assignedDrivers: drivers.assignedDrivers,
        pagesCompleted: Number(options.restart ? 0 : current?.pagesCompleted || 0) + 1,
        toursScanned: Number(options.restart ? 0 : current?.toursScanned || 0) + summary.tours,
        lastTourCursor: page.nextCursor || null,
        updatedAtMs: nowMs,
        ...(complete ? { completedAtMs: Number(current?.completedAtMs || nowMs) } : {}),
      };
    });
    if (!progressResult.committed) {
      throw new Error('Dashboard backfill progress changed concurrently; retry from the stored cursor');
    }
  }
  return {
    mode: options.apply ? 'apply' : 'dry-run',
    projectId,
    ...summary,
    driversScanned: drivers.totalDrivers,
    assignedDrivers: drivers.assignedDrivers,
    complete,
    resumeRequired: !complete,
    resumeCursorHash: cursorHash(page.nextCursor),
    alreadyComplete: false,
    retentionDays: BROADCAST_RETENTION_MS / 86_400_000,
  };
};

const closeAdminApps = async (admin) => {
  for (const app of admin?.apps || []) await app.delete();
};

async function main() {
  const admin = require('firebase-admin');
  try {
    if (!admin.apps.length) admin.initializeApp();
    const result = await run({ admin, options: parseArgs(process.argv.slice(2)) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await closeAdminApps(admin);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  PROGRESS_PATH,
  backfillDriverSummary: backfillDrivers,
  backfillTour,
  backfillTourPage,
  closeAdminApps,
  cursorHash,
  mapWithConcurrency,
  parseArgs,
  readKeyPage,
  run,
  scanMemberSummary,
};
