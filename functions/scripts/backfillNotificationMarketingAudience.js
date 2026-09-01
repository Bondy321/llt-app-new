#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const { selectSnapshotPage } = require('../src/infrastructure/database/rtdbQueryOrder');
const { TOUR_NOTIFICATION_CATEGORY_KEYS } = require('../src/domains/notifications/notificationPolicy');
const { mapWithBoundedConcurrency } = require('../src/domains/notifications/notificationAudienceEnumerators');
const { projectNotificationMarketingAudience } = require('../src/domains/notifications/notificationMarketingAudienceProjection');

const PROGRESS_PATH = 'notification_migrations/marketing_audience_v1';
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const DEFAULT_CONCURRENCY = 10;
const MAX_CONCURRENCY = 20;

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
  afterUid: readArg(argv, 'after-uid'),
  pageSize: boundedIntegerArg(argv, 'page-size', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  concurrency: boundedIntegerArg(argv, 'concurrency', DEFAULT_CONCURRENCY, MAX_CONCURRENCY),
});

const cursorHash = (cursor) => cursor
  ? createHash('sha256').update(cursor).digest('hex').slice(0, 16)
  : null;

const readDevicePage = async ({ db, afterUid, pageSize }) => {
  let query = db.ref('notification_devices').orderByKey();
  if (afterUid) query = query.startAfter(afterUid);
  const snapshot = await query.limitToFirst(pageSize + 1).once('value');
  const page = selectSnapshotPage(snapshot, pageSize);
  return {
    entries: page.entries,
    nextCursor: page.hasMore ? page.lastKey : null,
  };
};

const inspectDevice = async ({ db, authUid, device }) => {
  const [consentSnapshot, tombstoneSnapshot] = await Promise.all([
    db.ref(`notification_consents/${authUid}`).once('value'),
    db.ref(`notification_device_tombstones/${authUid}`).once('value'),
  ]);
  const consent = consentSnapshot.val();
  const tombstone = tombstoneSnapshot.val();
  const revision = Number(device?.registrationRevision || 0);
  const canonical = tombstone?.permanent !== true && revision > 0;
  const memberships = canonical && device?.marketingEligible === true
    ? TOUR_NOTIFICATION_CATEGORY_KEYS.filter((key) => (
      device?.marketingPreferences?.[key] === true && consent?.marketingPreferences?.[key] === true
    )).length
    : 0;
  return { canonical, memberships, revision };
};

const backfillPage = async ({ db, entries, apply, concurrency }) => {
  const results = await mapWithBoundedConcurrency(entries, concurrency, async ([authUid, device]) => {
    const inspection = await inspectDevice({ db, authUid, device });
    if (apply) {
      await projectNotificationMarketingAudience({
        db, authUid, beforeDevice: device, afterDevice: device,
      });
    }
    return inspection;
  });
  return results.reduce((summary, result) => ({
    scanned: summary.scanned + 1,
    canonical: summary.canonical + Number(result.canonical),
    memberships: summary.memberships + result.memberships,
  }), { scanned: 0, canonical: 0, memberships: 0 });
};

const run = async ({ admin, options, nowMs = Date.now() }) => {
  const projectId = admin.app().options.projectId || process.env.GCLOUD_PROJECT || '';
  if (options.apply && (!projectId || options.confirmProject !== projectId)) {
    throw new Error(`Refusing apply: pass --confirm-project=${projectId || '<project-id>'}`);
  }
  if (options.apply && options.afterUid && !options.restart) {
    throw new Error('Refusing apply cursor override without explicit --restart');
  }
  const db = admin.database();
  const progress = options.apply
    ? ((await db.ref(PROGRESS_PATH).once('value')).val() || {})
    : {};
  if (options.apply && progress.status === 'complete' && !options.restart) {
    return {
      mode: 'apply', projectId, scanned: 0, canonical: 0, memberships: 0,
      complete: true, resumeRequired: false, resumeCursorHash: null, alreadyComplete: true,
    };
  }
  let afterUid = options.afterUid || (options.apply && !options.restart ? String(progress.lastCursor || '') : '');
  const pageStartCursor = afterUid;
  const progressRevision = Number(progress.revision || 0);
  let summary = { scanned: 0, canonical: 0, memberships: 0 };
  let page = null;
  do {
    page = await readDevicePage({ db, afterUid, pageSize: options.pageSize });
    const pageSummary = await backfillPage({
      db, entries: page.entries, apply: options.apply, concurrency: options.concurrency,
    });
    summary = {
      scanned: summary.scanned + pageSummary.scanned,
      canonical: summary.canonical + pageSummary.canonical,
      memberships: summary.memberships + pageSummary.memberships,
    };
    afterUid = page.nextCursor || '';
  } while (!options.apply && page.nextCursor);
  const complete = !page.nextCursor;
  if (options.apply) {
    const progressResult = await db.ref(PROGRESS_PATH).transaction((current) => {
      if (Number(current?.revision || 0) !== progressRevision) return undefined;
      if (!options.restart && String(current?.lastCursor || '') !== pageStartCursor) return undefined;
      return {
        schemaVersion: 1,
        revision: progressRevision + 1,
        status: complete ? 'complete' : 'running',
        pagesCompleted: Number(options.restart ? 0 : current?.pagesCompleted || 0) + 1,
        recordsScanned: Number(options.restart ? 0 : current?.recordsScanned || 0) + summary.scanned,
        membershipsObserved: Number(options.restart ? 0 : current?.membershipsObserved || 0) + summary.memberships,
        lastCursor: page.nextCursor || null,
        updatedAtMs: nowMs,
        ...(complete ? { completedAtMs: Number(options.restart ? 0 : current?.completedAtMs || nowMs) } : {}),
      };
    });
    if (!progressResult.committed) {
      throw new Error('Marketing audience backfill progress changed concurrently; retry from the stored cursor');
    }
  }
  return {
    mode: options.apply ? 'apply' : 'dry-run',
    projectId,
    ...summary,
    complete,
    resumeRequired: !complete,
    resumeCursorHash: cursorHash(page.nextCursor),
    alreadyComplete: false,
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
  backfillPage,
  closeAdminApps,
  cursorHash,
  inspectDevice,
  parseArgs,
  readDevicePage,
  run,
};
