'use strict';

// @ts-check

const { admin } = require('../../bootstrap/firebaseAdmin');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { selectSnapshotPage } = require('../../infrastructure/database/rtdbQueryOrder');
const { loadNotificationAudiencePage } = require('./notificationAudiencePage');
const { readNotificationAudienceRollout } = require('./notificationAudienceRollout');
const { MARKETING_AUDIENCE_ROOT } = require('./notificationMarketingAudience');

const INDEXED_CURSOR_PREFIX = 'indexed_v1';
const SHADOW_CURSOR_PREFIX = 'shadow_v1';
const INDEXED_PAGE_SIZE = 100;
const ADMIN_DIRECTORY_LIMIT = 100;
const PRIMARY_ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';

/** @param {any} metrics @param {string} key @param {number} amount */
const count = (metrics, key, amount = 1) => {
  if (metrics && typeof metrics === 'object') metrics[key] = Number(metrics[key] || 0) + amount;
};

/** @param {any[]} items @param {number} concurrency @param {(item: any) => Promise<any>} callback */
const mapWithBoundedConcurrency = async (items, concurrency, callback) => {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await callback(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker));
  return results;
};

/** @param {string} source @param {string | null} after */
const encodeIndexedCursor = (source, after) => (
  after ? `${INDEXED_CURSOR_PREFIX}|${source}|${encodeURIComponent(after)}` : null
);

/** @param {string | null | undefined} cursor */
const decodeIndexedCursor = (cursor) => {
  if (typeof cursor !== 'string') return null;
  const [prefix, source, encodedAfter] = cursor.split('|');
  if (prefix !== INDEXED_CURSOR_PREFIX || !source || !encodedAfter) return null;
  try { return { source, after: decodeURIComponent(encodedAfter) }; } catch (_error) { return null; }
};

/** @param {any} state */
const encodeShadowCursor = (state) => `${SHADOW_CURSOR_PREFIX}|${Buffer.from(JSON.stringify(state)).toString('base64url')}`;

/** @param {string | null | undefined} cursor */
const decodeShadowCursor = (cursor) => {
  if (typeof cursor !== 'string' || !cursor.startsWith(`${SHADOW_CURSOR_PREFIX}|`)) return null;
  try {
    const state = JSON.parse(Buffer.from(cursor.slice(SHADOW_CURSOR_PREFIX.length + 1), 'base64url').toString('utf8'));
    return state && typeof state === 'object' ? state : null;
  } catch (_error) {
    return null;
  }
};

/** @param {any} db @param {string} tourId @param {string | null} after @param {number} pageSize @param {any} metrics */
const readOperationalTourPage = async (db, tourId, after, pageSize, metrics) => {
  let query = db.ref('notification_devices').orderByChild('operationalTourId');
  query = after && typeof query.startAfter === 'function'
    ? query.startAfter(tourId, after)
    : query.startAt(tourId, after || undefined);
  query = query.endAt(tourId).limitToFirst(pageSize + 1);
  count(metrics, 'rtdbQueries');
  const page = selectSnapshotPage(await query.once('value'), pageSize);
  const candidates = page.entries.map(([authUid, indexedDevice]) => ({
    authUid,
    source: 'indexed_operational',
    index: {
      operationalTourId: indexedDevice?.operationalTourId || null,
      registrationRevision: Number(indexedDevice?.registrationRevision || 0),
    },
  }));
  count(metrics, 'candidateRecordsReturned', candidates.length);
  return { candidates, nextCursor: page.hasMore ? encodeIndexedCursor('operational', page.lastKey) : null };
};

/** @param {any} db @param {string} categoryKey @param {string | null} after @param {number} pageSize @param {any} metrics */
const readMarketingPage = async (db, categoryKey, after, pageSize, metrics) => {
  let query = db.ref(`${MARKETING_AUDIENCE_ROOT}/${categoryKey}`).orderByKey();
  if (after) query = query.startAfter(after);
  count(metrics, 'rtdbQueries');
  const page = selectSnapshotPage(await query.limitToFirst(pageSize + 1).once('value'), pageSize);
  const candidates = page.entries.map(([authUid, membership]) => ({
    authUid, source: 'indexed_marketing', membership,
  }));
  count(metrics, 'candidateRecordsReturned', candidates.length);
  return { candidates, nextCursor: page.hasMore ? encodeIndexedCursor('marketing', page.lastKey) : null };
};

/** @param {any} db @param {any} metrics */
const readOperationsAdminUids = async (db, metrics) => {
  count(metrics, 'rtdbQueries');
  const snapshot = await db.ref('admin_users').orderByValue().equalTo(true)
    .limitToFirst(ADMIN_DIRECTORY_LIMIT + 1).once('value');
  const entries = selectSnapshotPage(snapshot, ADMIN_DIRECTORY_LIMIT + 1).entries;
  if (entries.length > ADMIN_DIRECTORY_LIMIT) {
    const error = new Error('Operations administrator directory exceeds notification safety bound');
    error.code = 'ADMIN_DIRECTORY_LIMIT_EXCEEDED';
    throw error;
  }
  return [...new Set([PRIMARY_ADMIN_UID, ...entries.slice(0, ADMIN_DIRECTORY_LIMIT).map(([authUid]) => authUid)])]
    .filter(isValidFirebaseKey)
    .sort();
};

/** @param {{ db: any, job: any, after: string | null, pageSize: number, metrics?: any }} input */
const loadIndexedAudiencePage = async ({ db, job, after, pageSize, metrics }) => {
  if (job.audienceType === 'single_installation') {
    const authUid = String(job.targetInstallationUid || '').trim();
    if (!isValidFirebaseKey(authUid) || after) return { candidates: [], nextCursor: null, exhausted: true, source: 'single_installation' };
    count(metrics, 'rtdbDirectReads');
    const device = (await db.ref(`notification_devices/${authUid}`).once('value')).val();
    const candidates = device ? [{ authUid, device, source: 'indexed_direct', canonicalDeviceLoaded: true }] : [];
    count(metrics, 'candidateRecordsReturned', candidates.length);
    return { candidates, nextCursor: null, exhausted: true, source: 'single_installation' };
  }
  if (job.audienceType === 'marketing') {
    if (!isValidFirebaseKey(job.categoryKey)) return { candidates: [], nextCursor: null, exhausted: true, source: 'marketing' };
    const page = await readMarketingPage(db, job.categoryKey, after, pageSize, metrics);
    return { ...page, exhausted: !page.nextCursor, source: 'marketing' };
  }
  if (!['tour', 'assigned_drivers', 'safety'].includes(job.audienceType) || !isValidFirebaseKey(job.tourId)) {
    return { candidates: [], nextCursor: null, exhausted: true, source: 'unsupported' };
  }
  const page = await readOperationalTourPage(db, job.tourId, after, pageSize, metrics);
  if (job.audienceType === 'safety' && !after) {
    const admins = await readOperationsAdminUids(db, metrics);
    const seen = new Set(page.candidates.map((candidate) => candidate.authUid));
    admins.forEach((authUid) => {
      if (!seen.has(authUid)) page.candidates.push({ authUid, source: 'indexed_safety_admin' });
    });
    count(metrics, 'candidateRecordsReturned', page.candidates.length - seen.size);
  }
  return { ...page, exhausted: !page.nextCursor, source: job.audienceType };
};

/** @param {{ db: any, job: any, candidates: any[], metrics?: any }} input */
const annotateShadowCandidates = async ({ db, job, candidates, metrics }) => {
  let adminUids = new Set();
  if (job.audienceType === 'safety') adminUids = new Set(await readOperationsAdminUids(db, metrics));
  return mapWithBoundedConcurrency(candidates, 10, async (candidate) => {
    let discovered = false;
    if (job.audienceType === 'single_installation') discovered = candidate.authUid === job.targetInstallationUid;
    else if (job.audienceType === 'marketing') {
      count(metrics, 'rtdbDirectReads');
      const membership = (await db.ref(`${MARKETING_AUDIENCE_ROOT}/${job.categoryKey}/${candidate.authUid}`).once('value')).val();
      discovered = Boolean(membership);
    } else {
      discovered = candidate.device?.operationalTourId === job.tourId
        || (job.audienceType === 'safety' && adminUids.has(candidate.authUid));
    }
    return { ...candidate, shadowIndexedDiscovered: discovered };
  });
};

const loadShadowAudiencePage = async ({ db, job, state, pageSize, metrics }) => {
  if (state.phase !== 'indexed') {
    const legacy = await loadNotificationAudiencePage(db, state.legacyCursor || null, pageSize);
    const candidates = await annotateShadowCandidates({ db, job, candidates: legacy.candidates, metrics });
    return {
      ...legacy,
      candidates,
      shadowIndexedCandidates: [],
      nextCursor: legacy.nextCursor
        ? encodeShadowCursor({ phase: 'legacy', legacyCursor: legacy.nextCursor })
        : encodeShadowCursor({ phase: 'indexed', indexedCursor: null }),
      exhausted: false,
      rolloutPhase: 'shadow_compare',
      source: 'legacy',
    };
  }
  const decodedIndexed = state.indexedCursor ? decodeIndexedCursor(state.indexedCursor) : null;
  const indexed = await loadIndexedAudiencePage({
    db, job, after: decodedIndexed?.after || null, pageSize, metrics,
  });
  return {
    candidates: [],
    shadowIndexedCandidates: indexed.candidates,
    nextCursor: indexed.nextCursor
      ? encodeShadowCursor({ phase: 'indexed', indexedCursor: indexed.nextCursor })
      : null,
    exhausted: !indexed.nextCursor,
    rolloutPhase: 'shadow_compare',
    source: 'shadow_indexed_comparison',
  };
};

/**
 * Explicit audience-enumerator boundary used by delivery and preview. A cursor
 * pins the chosen source for the lifetime of a durable fanout.
 * @param {{ db?: any, job: any, cursor?: string | null, pageSize?: number, metrics?: any }} input
 */
const enumerateNotificationAudiencePage = async ({
  db = admin.database(), job, cursor = null, pageSize = INDEXED_PAGE_SIZE, metrics = null,
}) => {
  const indexedCursor = decodeIndexedCursor(cursor);
  if (indexedCursor) return loadIndexedAudiencePage({ db, job, after: indexedCursor.after, pageSize, metrics });
  const shadowCursor = decodeShadowCursor(cursor);
  if (shadowCursor !== null) return loadShadowAudiencePage({ db, job, state: shadowCursor, pageSize, metrics });
  if (cursor) return { ...(await loadNotificationAudiencePage(db, cursor, pageSize)), rolloutPhase: 'legacy_scan', source: 'legacy' };

  count(metrics, 'rtdbDirectReads');
  const rollout = await readNotificationAudienceRollout(db);
  if (rollout.phase === 'indexed') return loadIndexedAudiencePage({ db, job, after: null, pageSize, metrics });
  const legacy = await loadNotificationAudiencePage(db, null, pageSize);
  if (rollout.phase !== 'shadow_compare') return { ...legacy, rolloutPhase: 'legacy_scan', source: 'legacy' };
  const candidates = await annotateShadowCandidates({ db, job, candidates: legacy.candidates, metrics });
  return {
    ...legacy,
    candidates,
    shadowIndexedCandidates: [],
    nextCursor: legacy.nextCursor
      ? encodeShadowCursor({ phase: 'legacy', legacyCursor: legacy.nextCursor })
      : encodeShadowCursor({ phase: 'indexed', indexedCursor: null }),
    exhausted: false,
    rolloutPhase: 'shadow_compare',
    source: 'legacy',
  };
};

module.exports = {
  ADMIN_DIRECTORY_LIMIT,
  INDEXED_CURSOR_PREFIX,
  INDEXED_PAGE_SIZE,
  PRIMARY_ADMIN_UID,
  SHADOW_CURSOR_PREFIX,
  annotateShadowCandidates,
  decodeIndexedCursor,
  decodeShadowCursor,
  encodeIndexedCursor,
  encodeShadowCursor,
  enumerateNotificationAudiencePage,
  loadIndexedAudiencePage,
  mapWithBoundedConcurrency,
  readMarketingPage,
  readOperationalTourPage,
  readOperationsAdminUids,
};
