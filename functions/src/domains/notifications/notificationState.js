'use strict';

// @ts-check

const { createHash } = require('node:crypto');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { log } = require('../../infrastructure/logging/safeLogger');
const { compactNotificationText, resolveTrimmedString } = require('./notificationPolicy');
const { buildPushNavigationData } = require('./pushNavigationData');
const { isOpaquePassengerId } = loadLegacyLibrary('passengerIdentity');

const TOUR_NOTIFICATION_MAX_RECORDS = 100;
const NOTIFICATION_READ_CLEANUP_JOB_BATCH_SIZE = 10;
const NOTIFICATION_READ_CLEANUP_USER_BATCH_SIZE = 50;
const LEGACY_NOTIFICATION_READ_CLEANUP_BATCH_SIZE = 50;
const LEGACY_NOTIFICATION_READ_CLEANUP_CONCURRENCY = 5;
const LEGACY_NOTIFICATION_READ_CLEANUP_STATE_PATH = 'notification_read_legacy_cleanup_state/v1';
const LEGACY_NOTIFICATION_READ_CLEANUP_QUEUE_PATH = 'notification_read_legacy_cleanup_queue';
const LEGACY_NOTIFICATION_READ_CLEANUP_SEED_BATCH_SIZE = 200;
/** @type {(...args: any[]) => any} */
const buildTourNotificationId = ({ type, tourId, sourceId }) => {
  const digest = createHash('sha256')
    .update(`${type || 'update'}:${tourId || 'unknown'}:${sourceId || 'unknown'}`)
    .digest('hex')
    .slice(0, 32);
  return `ntf_${digest}`;
};

/** @type {(...args: any[]) => any} */
const normalizeItineraryDaysForDiff = (itinerary = {}) => {
  const days = Array.isArray(itinerary?.days) ? itinerary.days : [];
  const normalized = new Map();
  days.forEach(/** @param {any} day @param {number} index */ (day, index) => {
    const dayNumber = Number.isFinite(Number(day?.day)) ? Number(day.day) : index + 1;
    normalized.set(dayNumber, compactNotificationText(JSON.stringify(day || {}), 4000));
  });
  return normalized;
};

/** @type {(...args: any[]) => any} */
const summarizeItineraryChange = (before = {}, after = {}) => {
  const beforeDays = normalizeItineraryDaysForDiff(before);
  const afterDays = normalizeItineraryDaysForDiff(after);
  const allDayNumbers = [...new Set([...beforeDays.keys(), ...afterDays.keys()])].sort((a, b) => a - b);
  const changedDays = allDayNumbers.filter((dayNumber) => beforeDays.get(dayNumber) !== afterDays.get(dayNumber));
  const titleChanged = compactNotificationText(before?.title, 160) !== compactNotificationText(after?.title, 160);

  if (beforeDays.size === 0 && afterDays.size > 0) {
    return {
      title: 'Itinerary available',
      body: `Your ${afterDays.size}-day itinerary is now available. Tap to review the schedule.`,
      changedDayCount: afterDays.size,
      changeType: 'published',
      hasMeaningfulChange: true,
    };
  }

  if (afterDays.size === 0) {
    return {
      title: 'Itinerary being revised',
      body: 'The itinerary is being revised. Open the app for the latest tour information.',
      changedDayCount: beforeDays.size,
      changeType: 'withdrawn',
      hasMeaningfulChange: beforeDays.size > 0,
    };
  }

  if (changedDays.length === 1) {
    return {
      title: 'Itinerary updated',
      body: `Day ${changedDays[0]} has changed. Tap to review the updated schedule.`,
      changedDayCount: 1,
      changeType: 'updated',
      hasMeaningfulChange: true,
    };
  }

  if (changedDays.length > 1) {
    return {
      title: 'Itinerary updated',
      body: `${changedDays.length} itinerary days have changed. Tap to review the updated schedule.`,
      changedDayCount: changedDays.length,
      changeType: 'updated',
      hasMeaningfulChange: true,
    };
  }

  return {
    title: titleChanged ? 'Itinerary updated' : null,
    body: titleChanged
      ? 'Your itinerary details have changed. Tap to review the latest schedule.'
      : null,
    changedDayCount: 0,
    changeType: titleChanged ? 'updated' : 'metadata_only',
    hasMeaningfulChange: titleChanged,
  };
};

/** @type {(...args: any[]) => any} */
const buildTourNotificationRecord = ({
  type,
  tourId,
  sourceId,
  title,
  body,
  screen,
  createdAtMs = Date.now(),
  priority = 'normal',
  messageId = null,
  departureKey = null,
  revision = null,
  changedSections = null,
  critical = false,
  requiresAcknowledgement = false,
}) => {
  const noticeId = buildTourNotificationId({ type, tourId, sourceId });
  return {
    noticeId,
    version: 1,
    type,
    title: compactNotificationText(title, 120),
    body: compactNotificationText(body, 300),
    tourId,
    screen,
    sourceId: compactNotificationText(sourceId, 160),
    ...(resolveTrimmedString(messageId) ? { messageId: resolveTrimmedString(messageId) } : {}),
    ...(resolveTrimmedString(departureKey) ? { departureKey: resolveTrimmedString(departureKey) } : {}),
    ...(Number.isSafeInteger(revision) && revision >= 1 ? { revision } : {}),
    ...(Array.isArray(changedSections) && changedSections.length
      ? { changedSections: changedSections.join(',').slice(0, 240) }
      : {}),
    ...(critical === true ? { critical: true } : {}),
    ...(requiresAcknowledgement === true ? { requiresAcknowledgement: true } : {}),
    priority: priority === 'high' ? 'high' : 'normal',
    createdAt: new Date(createdAtMs).toISOString(),
    createdAtMs,
  };
};

/** @type {(...args: any[]) => Promise<any>} */
const persistTourNotification = async ({ db = admin.database(), record }) => {
  if (!record || !isValidFirebaseKey(record.tourId) || !isValidFirebaseKey(record.noticeId)) {
    throw new Error('Invalid tour notification record');
  }

  const noticesRef = db.ref(`tour_notifications/${record.tourId}`);
  /** @type {string[]} */
  let evictedNoticeIds = [];
  await noticesRef.transaction(/** @param {any} currentValue */ (currentValue) => {
    evictedNoticeIds = [];
    const nextValue = currentValue && typeof currentValue === 'object' ? { ...currentValue } : {};
    nextValue[record.noticeId] = record;

    const sorted = Object.entries(nextValue).sort(([, left], [, right]) => {
      const timeDelta = Number(left?.createdAtMs || 0) - Number(right?.createdAtMs || 0);
      return timeDelta || String(left?.noticeId || '').localeCompare(String(right?.noticeId || ''));
    });
    while (sorted.length > TOUR_NOTIFICATION_MAX_RECORDS) {
      const oldest = sorted.shift();
      if (!oldest) break;
      const [oldestId] = oldest;
      evictedNoticeIds.push(oldestId);
      delete nextValue[oldestId];
    }
    return nextValue;
  });

  if (evictedNoticeIds.length > 0) {
    await enqueueNotificationReadCleanupJobs({
      db,
      tourId: record.tourId,
      noticeIds: evictedNoticeIds,
    });
  }

  return record;
};

/** @type {(...args: any[]) => any} */
const buildNotificationReadCleanupJobId = ({ tourId, noticeId }) => `nrc_${createHash('sha256')
  .update(`${tourId}:${noticeId}`)
  .digest('hex')
  .slice(0, 32)}`;

/** @type {(...args: any[]) => Promise<any>} */
const enqueueNotificationReadCleanupJobs = async ({
  db = admin.database(),
  tourId,
  noticeIds = [],
  now = Date.now(),
}) => {
  if (!isValidFirebaseKey(tourId)) {
    throw new Error('Invalid notification cleanup tour id');
  }

  const safeNoticeIds = [...new Set(noticeIds.filter(isValidFirebaseKey))];
  await Promise.all(safeNoticeIds.map(async (noticeId) => {
    const jobId = buildNotificationReadCleanupJobId({ tourId, noticeId });
    await db.ref(`notification_read_cleanup_jobs/${jobId}`).transaction(/** @param {any} currentValue */ (currentValue) => (
      currentValue || {
        version: 1,
        jobId,
        tourId,
        noticeId,
        createdAtMs: now,
        updatedAtMs: now,
        afterUserId: null,
        processedUserCount: 0,
      }
    ));
  }));
  return safeNoticeIds.length;
};

/** @type {(...args: any[]) => Promise<any>} */
const processNotificationReadMigrationRequest = async ({
  db = admin.database(),
  tourId,
  authUid,
  request,
  now = Date.now(),
}) => {
  const requestPath = `notification_read_migration_requests/${tourId}/${authUid}`;
  const principalId = resolveTrimmedString(request?.principalId);
  if (!isValidFirebaseKey(tourId)
    || !isValidFirebaseKey(authUid)
    || request?.version !== 1
    || !isValidFirebaseKey(principalId)
    || principalId === authUid) {
    await db.ref(requestPath).remove();
    return { legacyRemoved: false, invalid: true };
  }

  const profileSnapshot = await db.ref(`users/${authUid}`).once('value');
  const profile = profileSnapshot.val() || {};
  const stablePassengerKey = resolveTrimmedString(profile.stablePassengerKey);
  const driverId = resolveTrimmedString(profile.driverId);
  const expectedPrincipalId = isValidFirebaseKey(stablePassengerKey)
    && resolveTrimmedString(profile.stablePassengerId)
    ? stablePassengerKey
    : isValidFirebaseKey(driverId)
      ? `driver:${driverId}`
      : null;

  if (principalId !== expectedPrincipalId
    || profile.notificationReadStateUpgradedTours?.[tourId] === true) {
    await db.ref(requestPath).remove();
    return { legacyRemoved: false, invalid: true };
  }

  await db.ref().update({
    [`notification_read_state/${tourId}/${authUid}`]: null,
    [requestPath]: null,
    [`users/${authUid}/notificationReadStateUpgradedTours/${tourId}`]: true,
  });
  return {
    legacyRemoved: true,
    invalid: false,
    principalId,
    completedAtMs: now,
  };
};

/** @param {any} db */
const resolveRealtimeDatabaseAccess = (db) => {
  const databaseApp = db && db.app ? db.app : null;
  const defaultApp = admin.app();
  const databaseOptions = databaseApp && databaseApp.options ? databaseApp.options : {};
  const defaultOptions = defaultApp && defaultApp.options ? defaultApp.options : {};
  return {
    databaseURL: resolveTrimmedString(databaseOptions.databaseURL)
      || resolveTrimmedString(defaultOptions.databaseURL),
    credential: databaseOptions.credential || defaultOptions.credential,
  };
};

/** @type {(...args: any[]) => Promise<any>} */
const fetchRealtimeDatabaseShallowKeys = async ({ db = admin.database(), path, fetchImpl = fetch }) => {
  const { databaseURL, credential } = resolveRealtimeDatabaseAccess(db);
  if (!databaseURL || !credential?.getAccessToken || typeof fetchImpl !== 'function') {
    throw new Error('Realtime Database shallow-key access is unavailable');
  }
  const accessToken = await credential.getAccessToken();
  const token = resolveTrimmedString(accessToken?.access_token);
  if (!token) throw new Error('Realtime Database cleanup access token is unavailable');
  const encodedPath = String(path || '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  const response = await fetchImpl(
    `${databaseURL.replace(/\/$/, '')}/${encodedPath}.json?shallow=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new Error(`Realtime Database shallow-key read failed (${response.status})`);
  const value = await response.json();
  return Object.keys(value && typeof value === 'object' ? value : {})
    .filter(isValidFirebaseKey)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
};

/** @type {(...args: any[]) => any} */
const shouldDeleteLegacyNotificationReadPrincipal = ({ principalId, profile, authUserExists = false }) => {
  if (!isValidFirebaseKey(principalId)
    || isOpaquePassengerId(principalId)
    || principalId.startsWith('driver:')) return false;
  if (!profile || typeof profile !== 'object') return !authUserExists;
  return isValidFirebaseKey(resolveTrimmedString(profile.stablePassengerKey))
    || isValidFirebaseKey(resolveTrimmedString(profile.driverId));
};

/** @type {(...args: any[]) => Promise<any>} */
const seedLegacyNotificationCleanup = async ({ db, stateRef, listTourIds, now }) => {
  const tourIds = await listTourIds();
  for (let offset = 0; offset < tourIds.length; offset += LEGACY_NOTIFICATION_READ_CLEANUP_SEED_BATCH_SIZE) {
    const queueUpdates = Object.fromEntries(
      tourIds.slice(offset, offset + LEGACY_NOTIFICATION_READ_CLEANUP_SEED_BATCH_SIZE)
        .map(/** @param {string} tourId */ (tourId) => [tourId, { version: 1, afterPrincipalId: null }]),
    );
    await db.ref(LEGACY_NOTIFICATION_READ_CLEANUP_QUEUE_PATH).update(queueUpdates);
  }
  const completed = tourIds.length === 0;
  await stateRef.set({
    version: 1,
    seeded: true,
    completed,
    ...(completed ? { completedAtMs: now } : {}),
    updatedAtMs: now,
  });
  return {
    seeded: true,
    completed,
    discoveredTourCount: tourIds.length,
    processedCount: 0,
    deletedCount: 0,
  };
};

/** @param {any} db */
const loadLegacyCleanupQueue = async (db) => {
  const snapshot = await db.ref(LEGACY_NOTIFICATION_READ_CLEANUP_QUEUE_PATH)
    .orderByKey()
    .limitToFirst(2)
    .once('value');
  return Object.entries(snapshot.val() || {})
    .filter(([tourId]) => isValidFirebaseKey(tourId))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
};

/** @type {(...args: any[]) => Promise<any>} */
const loadLegacyPrincipalPage = async ({ db, tourId, queueItem }) => {
  const afterPrincipalId = isValidFirebaseKey(queueItem?.afterPrincipalId)
    ? queueItem.afterPrincipalId
    : null;
  let query = db.ref(`notification_read_state/${tourId}`).orderByKey();
  if (afterPrincipalId) query = query.startAt(afterPrincipalId);
  const snapshot = await query
    .limitToFirst(LEGACY_NOTIFICATION_READ_CLEANUP_BATCH_SIZE + (afterPrincipalId ? 2 : 1))
    .once('value');
  const entries = Object.entries(snapshot.val() || {})
    .filter(([principalId]) => isValidFirebaseKey(principalId)
      && (!afterPrincipalId || principalId > afterPrincipalId))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return { entries, pageEntries: entries.slice(0, LEGACY_NOTIFICATION_READ_CLEANUP_BATCH_SIZE) };
};

/** @param {any} db @param {string[]} page */
const loadLegacyPrincipalProfiles = async (db, page) => {
  const profiles = new Map();
  let cursor = 0;
  const workers = Array.from({
    length: Math.min(LEGACY_NOTIFICATION_READ_CLEANUP_CONCURRENCY, page.length),
  }, async () => {
    while (cursor < page.length) {
      const index = cursor;
      cursor += 1;
      const principalId = page[index];
      if (!principalId || isOpaquePassengerId(principalId) || principalId.startsWith('driver:')) continue;
      const snapshot = await db.ref(`users/${principalId}`).once('value');
      profiles.set(principalId, snapshot.val());
    }
  });
  await Promise.all(workers);
  return profiles;
};

/** @type {(...args: any[]) => Promise<any>} */
const processLegacyNotificationReadStateCleanup = async ({
  db = admin.database(),
  listTourIds = () => fetchRealtimeDatabaseShallowKeys({ db, path: 'notification_read_state' }),
  resolveExistingAuthUids = async (/** @type {string[]} */ uids) => {
    if (uids.length === 0) return new Set();
    const result = await admin.auth().getUsers(uids.map(/** @param {string} uid */ (uid) => ({ uid })));
    return new Set((result.users || []).map((user) => user.uid));
  },
  now = Date.now(),
} = {}) => {
  const stateRef = db.ref(LEGACY_NOTIFICATION_READ_CLEANUP_STATE_PATH);
  const stateSnapshot = await stateRef.once('value');
  const state = stateSnapshot.val() || {};
  if (state.completed === true) return { completed: true, processedCount: 0, deletedCount: 0 };

  if (state.seeded !== true) {
    return seedLegacyNotificationCleanup({ db, stateRef, listTourIds, now });
  }

  const queueEntries = await loadLegacyCleanupQueue(db);
  const [tourId, queueItem = {}] = queueEntries[0] || [];
  if (!tourId) {
    await stateRef.set({
      version: 1,
      seeded: true,
      completed: true,
      completedAtMs: now,
      updatedAtMs: now,
    });
    return { completed: true, processedCount: 0, deletedCount: 0 };
  }

  const { entries: principalEntries, pageEntries } = await loadLegacyPrincipalPage({ db, tourId, queueItem });
  const page = pageEntries.map(/** @param {[string, any]} entry */ ([principalId]) => principalId);
  const profiles = await loadLegacyPrincipalProfiles(db, page);

  const missingProfileUids = page.filter(/** @param {string} principalId */ (principalId) => (
    !isOpaquePassengerId(principalId)
    && !principalId.startsWith('driver:')
    && !profiles.get(principalId)
    && principalId.length <= 128
  ));
  const existingAuthUids = await resolveExistingAuthUids(missingProfileUids);

  /** @type {Record<string, any>} */
  const updates = {};
  page.forEach(/** @param {string} principalId */ (principalId) => {
    if (shouldDeleteLegacyNotificationReadPrincipal({
      principalId,
      profile: profiles.get(principalId),
      authUserExists: existingAuthUids.has(principalId),
    })) {
      updates[`notification_read_state/${tourId}/${principalId}`] = null;
    }
  });
  const hasMoreInTour = principalEntries.length > pageEntries.length;
  const hasMoreTours = queueEntries.length > 1;
  updates[`${LEGACY_NOTIFICATION_READ_CLEANUP_QUEUE_PATH}/${tourId}`] = hasMoreInTour
    ? { version: 1, afterPrincipalId: page.at(-1), updatedAtMs: now }
    : null;
  updates[LEGACY_NOTIFICATION_READ_CLEANUP_STATE_PATH] = {
    version: 1,
    seeded: true,
    completed: !hasMoreInTour && !hasMoreTours,
    ...(!hasMoreInTour && !hasMoreTours ? { completedAtMs: now } : {}),
    updatedAtMs: now,
  };
  await db.ref().update(updates);
  return {
    completed: !hasMoreInTour && !hasMoreTours,
    tourId,
    processedCount: page.length,
    deletedCount: Object.keys(updates).filter((path) => path.startsWith('notification_read_state/')).length,
  };
};

/** @type {(...args: any[]) => Promise<any>} */
const processNotificationReadCleanupJob = async ({ db = admin.database(), jobId, job, now = Date.now() }) => {
  if (!isValidFirebaseKey(jobId)
    || !job
    || job.version !== 1
    || job.jobId !== jobId
    || !isValidFirebaseKey(job.tourId)
    || !isValidFirebaseKey(job.noticeId)) {
    await db.ref(`notification_read_cleanup_jobs/${jobId}`).remove();
    return { completed: true, removedReadCount: 0, processedUserCount: 0, invalid: true };
  }

  const afterUserId = isValidFirebaseKey(job.afterUserId) ? job.afterUserId : null;
  let usersQuery = db.ref(`notification_read_state/${job.tourId}`).orderByKey();
  if (afterUserId) usersQuery = usersQuery.startAt(afterUserId);
  const snapshot = await usersQuery
    .limitToFirst(NOTIFICATION_READ_CLEANUP_USER_BATCH_SIZE + (afterUserId ? 2 : 1))
    .once('value');
  const userEntries = Object.entries(snapshot.val() || {})
    .filter(([userId]) => isValidFirebaseKey(userId) && (!afterUserId || userId > afterUserId))
    .sort(([left], [right]) => left.localeCompare(right));
  const pageEntries = userEntries.slice(0, NOTIFICATION_READ_CLEANUP_USER_BATCH_SIZE);
  const hasMore = userEntries.length > pageEntries.length;
  /** @type {Record<string, any>} */
  const updates = {};

  pageEntries.forEach(([userId, userState]) => {
    if (userState && typeof userState === 'object' && Object.prototype.hasOwnProperty.call(userState, job.noticeId)) {
      updates[`notification_read_state/${job.tourId}/${userId}/${job.noticeId}`] = null;
    }
  });
  if (Object.keys(updates).length > 0) await db.ref().update(updates);

  if (!hasMore) {
    await db.ref(`notification_read_cleanup_jobs/${jobId}`).remove();
    return {
      completed: true,
      removedReadCount: Object.keys(updates).length,
      processedUserCount: pageEntries.length,
    };
  }

  const nextCursor = pageEntries.at(-1)?.[0];
  await db.ref(`notification_read_cleanup_jobs/${jobId}`).update({
    afterUserId: nextCursor,
    processedUserCount: Number(job.processedUserCount || 0) + pageEntries.length,
    updatedAtMs: now,
  });
  return {
    completed: false,
    removedReadCount: Object.keys(updates).length,
    processedUserCount: pageEntries.length,
    afterUserId: nextCursor,
  };
};

/** @type {(...args: any[]) => Promise<any>} */
const processNotificationReadCleanupJobs = async ({ db = admin.database(), now = Date.now() } = {}) => {
  const snapshot = await db.ref('notification_read_cleanup_jobs')
    .orderByChild('createdAtMs')
    .limitToFirst(NOTIFICATION_READ_CLEANUP_JOB_BATCH_SIZE)
    .once('value');
  const jobs = Object.entries(snapshot.val() || {});
  const results = [];
  for (const [jobId, job] of jobs) {
    try {
      results.push(await processNotificationReadCleanupJob({ db, jobId, job, now }));
    } catch (error) {
      log.warn('Notification read-state cleanup job deferred', {
        jobId,
        tourId: job?.tourId,
        error: error instanceof Error ? error.message : String(error),
      });
      results.push({ completed: false, error: true });
    }
  }
  return results;
};


module.exports = {
  buildNotificationReadCleanupJobId,
  buildPushNavigationData,
  buildTourNotificationId,
  buildTourNotificationRecord,
  enqueueNotificationReadCleanupJobs,
  fetchRealtimeDatabaseShallowKeys,
  normalizeItineraryDaysForDiff,
  persistTourNotification,
  processLegacyNotificationReadStateCleanup,
  processNotificationReadCleanupJob,
  processNotificationReadCleanupJobs,
  processNotificationReadMigrationRequest,
  shouldDeleteLegacyNotificationReadPrincipal,
  summarizeItineraryChange,
};
