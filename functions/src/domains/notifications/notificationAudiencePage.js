'use strict';

// @ts-check

const { createHash } = require('node:crypto');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { selectSnapshotPage } = require('../../infrastructure/database/rtdbQueryOrder');
const { isValidPushToken, userWantsTourCategoryBroadcast } = require('./notificationPolicy');
const { getNotificationDeliveryPolicy } = require('./notificationDeliveryPolicy');
const { isValidMarketingAudienceMembership } = require('./notificationMarketingAudience');
const {
  driverBindingAllowedByPolicy,
  driverSessionMatchesPolicyGeneration,
  readDriverLoginPolicy,
} = require('../driver-auth/public');

const { isActiveSessionRecord } = loadLegacyLibrary('appSession');
const PAGE_SIZE = 100;
const PRIMARY_ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const DEVICE_MIGRATION_STATE_PATH = 'notification_migrations/device_registry_v1';
const ELIGIBLE_PERMISSION_STATES = new Set(['granted', 'provisional', 'ephemeral']);

/** @param {string | null | undefined} cursor */
const decodeAudienceCursor = (cursor) => {
  if (typeof cursor !== 'string' || !cursor.includes('|')) return { phase: 'devices', after: null };
  const [phase, ...rest] = cursor.split('|');
  return { phase: phase === 'users' ? 'users' : 'devices', after: rest.join('|') || null };
};

/** @param {'devices' | 'users'} phase @param {string | null} after */
const encodeAudienceCursor = (phase, after) => (after ? `${phase}|${after}` : `${phase}|`);

/** @param {any} db @param {string} root @param {string | null} after @param {number} pageSize */
const readKeyPage = async (db, root, after, pageSize) => {
  let query = db.ref(root).orderByKey();
  if (after) query = query.startAfter(after);
  const snapshot = await query.limitToFirst(pageSize + 1).once('value');
  const page = selectSnapshotPage(snapshot, pageSize);
  return {
    entries: page.entries,
    hasMore: page.hasMore,
    lastKey: page.lastKey || after,
  };
};

/** @param {any} db @param {string | null | undefined} cursor @param {number} pageSize */
const loadNotificationAudiencePage = async (db = admin.database(), cursor = null, pageSize = PAGE_SIZE) => {
  const decoded = decodeAudienceCursor(cursor);
  if (decoded.phase === 'devices') {
    const page = await readKeyPage(db, 'notification_devices', decoded.after, pageSize);
    if (page.entries.length || page.hasMore) {
      return {
        phase: 'devices',
        candidates: page.entries.map(([authUid, record]) => ({ authUid, device: record, source: 'device' })),
        nextCursor: page.hasMore ? encodeAudienceCursor('devices', page.lastKey) : encodeAudienceCursor('users', null),
        exhausted: false,
      };
    }
  }

  const migrationSnapshot = await db.ref(DEVICE_MIGRATION_STATE_PATH).once('value');
  if (migrationSnapshot.val()?.legacyFallbackEnabled === false) {
    return {
      phase: 'users', candidates: [], nextCursor: null, exhausted: true,
    };
  }

  const usersAfter = decoded.phase === 'users' ? decoded.after : null;
  const page = await readKeyPage(db, 'users', usersAfter, pageSize);
  const candidates = (await Promise.all(page.entries.map(async ([authUid, profile]) => {
    const canonicalSnapshot = await db.ref(`notification_devices/${authUid}`).once('value');
    if (canonicalSnapshot.exists()) return null;
    return { authUid, profile, source: 'legacy_user' };
  }))).filter(Boolean);
  return {
    phase: 'users',
    candidates,
    nextCursor: page.hasMore ? encodeAudienceCursor('users', page.lastKey) : null,
    exhausted: !page.hasMore,
  };
};

/** @param {any} value */
const normalizePermissionState = (value) => String(value || '').trim().toLowerCase();
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const readCanonicalString = (device, key) => (
  hasOwn(device, key) && typeof device[key] === 'string' ? device[key].trim() : ''
);
const normalizeCanonicalDevice = (candidate, device, legacy) => ({
  authUid: candidate.authUid,
  pushToken: readCanonicalString(device, 'pushToken'),
  status: readCanonicalString(device, 'status').toLowerCase(),
  permissionState: normalizePermissionState(readCanonicalString(device, 'permissionState')),
  operationalEligible: device.operationalEligible === true,
  marketingEligible: device.marketingEligible === true,
  marketingPreferences: device.marketingPreferences && typeof device.marketingPreferences === 'object'
    ? device.marketingPreferences
    : {},
  platform: readCanonicalString(device, 'platform').toLowerCase(),
  profile: legacy,
});
const normalizeLegacyDevice = (candidate, legacy) => ({
  authUid: candidate.authUid,
  pushToken: String(legacy.pushToken || '').trim(),
  status: String(legacy.pushTokenStatus || '').trim().toLowerCase(),
  permissionState: normalizePermissionState(legacy.pushPermissionState),
  operationalEligible: String(legacy.pushTokenStatus || '').toUpperCase() === 'ACTIVE',
  marketingEligible: false,
  marketingPreferences: legacy?.preferences?.marketing || {},
  platform: String(legacy.deviceOS || '').trim().toLowerCase(),
  profile: legacy,
});

/** @param {any} candidate @param {any} profile */
const normalizeNotificationDevice = (candidate, profile) => {
  const device = candidate?.device && typeof candidate.device === 'object' ? candidate.device : {};
  const legacy = profile && typeof profile === 'object' ? profile : {};
  const canonical = candidate?.source === 'device'
    || Object.prototype.hasOwnProperty.call(candidate || {}, 'device');
  return canonical
    ? normalizeCanonicalDevice(candidate, device, legacy)
    : normalizeLegacyDevice(candidate, legacy);
};

/** @param {any} value @param {string[]} path @param {boolean} fallback */
const readBooleanPath = (value, path, fallback = false) => {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object') return fallback;
    current = current[key];
  }
  return typeof current === 'boolean' ? current : fallback;
};

/** @param {any} db @param {string} authUid */
const countMetric = (metrics, key, amount = 1) => {
  if (metrics && typeof metrics === 'object') metrics[key] = Number(metrics[key] || 0) + amount;
};
const isOperationsAdmin = async (db, authUid, metrics = null) => {
  if (authUid === PRIMARY_ADMIN_UID) return true;
  countMetric(metrics, 'rtdbDirectReads');
  const snapshot = await db.ref(`admin_users/${authUid}`).once('value');
  return snapshot.val() === true;
};

// Final assignment and policy authority is intentionally candidate-local. A
// page cache would become stale if either fence changes after enumeration.
const loadAudienceEvaluationContext = async () => ({});

/** @param {any} db @param {string} authUid @param {any} profile @param {string} tourId */
const resolveOperationalAuthority = async (db, authUid, profile, tourId, nowMs = Date.now(), metrics = null) => {
  countMetric(metrics, 'rtdbDirectReads');
  const sessionSnapshot = await db.ref(`app_sessions/${authUid}`).once('value');
  const session = sessionSnapshot.val();
  if (!isActiveSessionRecord(session, { nowMs }) || session.authUid !== authUid) {
    return { allowed: false, reason: 'inactive_operational_session' };
  }
  if (session.tourId !== tourId) return { allowed: false, reason: 'wrong_tour' };
  if (session.principalType === 'passenger') return resolvePassengerAuthority(db, authUid, tourId, session, nowMs, metrics);
  return resolveDriverAuthority(db, authUid, profile, tourId, session, metrics);
};
const resolvePassengerAuthority = async (db, authUid, tourId, session, nowMs, metrics = null) => {
    countMetric(metrics, 'rtdbDirectReads');
    const participantSnapshot = await db.ref(`tours/${tourId}/participants/${authUid}`).once('value');
    const participant = participantSnapshot.val();
    if (!participant) return { allowed: false, reason: 'wrong_tour' };
    if (participant.schemaVersion === 2
      && (participant.sessionId !== session.sessionId
        || participant.principalId !== session.principalId
        || Number(participant.sessionExpiresAtMs) <= nowMs)) {
      return { allowed: false, reason: 'inactive_operational_session' };
    }
    return { allowed: true, session, role: 'passenger' };
};
const resolveDriverAuthority = async (db, authUid, profile, tourId, session, metrics = null) => {
  const driverId = String(session.driverId || profile?.driverId || '').trim();
  if (!isValidFirebaseKey(driverId)) return { allowed: false, reason: 'wrong_tour' };
  countMetric(metrics, 'rtdbDirectReads', 3);
  const [driverSnapshot, policyContext, assignmentSnapshot] = await Promise.all([
    db.ref(`drivers/${driverId}`).once('value'),
    readDriverLoginPolicy({ db }),
    db.ref(`tour_manifests/${tourId}/assigned_drivers/${driverId}`).once('value'),
  ]);
  const policy = policyContext.policy;
  const driver = driverSnapshot.val() || {};
  if (!driverSessionMatchesPolicyGeneration(session, policy)
    || !driverBindingAllowedByPolicy({
      policy, authUid, claimedAuthUid: driver.authUid,
    })
    || profile?.driverId !== driverId
    || profile?.driverPrincipalId !== session.principalId
    || profile?.principalType !== 'driver'
    || driver.currentTourId !== tourId
    || assignmentSnapshot.val() !== true) {
    return { allowed: false, reason: 'wrong_tour' };
  }
  return { allowed: true, session, role: 'driver' };
};

/** @param {string} token */
const hashPushToken = (token) => createHash('sha256').update(token).digest('hex');
const evaluateCandidateBase = (job, authUid, device) => {
  if (job.targetInstallationUid && job.targetInstallationUid !== authUid) return 'wrong_tour';
  if (!device.pushToken) return 'no_token';
  if (!ELIGIBLE_PERMISSION_STATES.has(device.permissionState)) return ['denied', 'blocked', 'unavailable'].includes(device.permissionState) ? `permission_${device.permissionState}` : 'permission_unavailable';
  if (device.status !== 'active') return 'inactive_token';
  if (!isValidPushToken(device.pushToken)) return 'invalid_token';
  if (job.senderAuthUid === authUid) return 'sender_excluded';
  return null;
};
const evaluateDriverAudience = (job, authority) => {
  if (job.audienceType !== 'assigned_drivers') return null;
  if (authority.role !== 'driver') return 'wrong_tour';
  return Array.isArray(job.allowedDriverIds) && job.allowedDriverIds.length && !job.allowedDriverIds.includes(authority.session?.driverId) ? 'opted_out' : null;
};
const evaluateAudienceAuthority = async (db, job, authUid, profile, device, nowMs, metrics = null) => {
  if (job.audienceType === 'marketing') return device.marketingEligible && userWantsTourCategoryBroadcast({ preferences: { marketing: device.marketingPreferences } }, job.categoryKey) ? null : 'opted_out';
  if (job.audienceType === 'single_installation') return null;
  countMetric(metrics, 'authorityEvaluations');
  if (job.audienceType === 'safety' && await isOperationsAdmin(db, authUid, metrics)) return null;
  if (!device.operationalEligible) return 'inactive_operational_session';
  const authority = await resolveOperationalAuthority(db, authUid, profile, job.tourId, nowMs, metrics);
  if (!authority.allowed) return authority.reason || 'wrong_tour';
  if (job.audienceType === 'safety' && authority.role !== 'driver') return 'wrong_tour';
  if (job.senderPrincipalId && authority.session?.principalId === job.senderPrincipalId) return 'sender_excluded';
  return evaluateDriverAudience(job, authority);
};

const isIndexedCandidate = (candidate) => String(candidate?.source || '').startsWith('indexed_');
// eslint-disable-next-line complexity -- indexed discovery is revalidated against every canonical fence
const loadIndexedCanonicalCandidate = async ({ db, job, candidate, metrics }) => {
  const authUid = String(candidate.authUid || '').trim();
  const reads = [];
  if (candidate.canonicalDeviceLoaded === true) reads.push(Promise.resolve({ kind: 'device', value: candidate.device || null }));
  else reads.push(db.ref(`notification_devices/${authUid}`).once('value').then((snapshot) => ({ kind: 'device', value: snapshot.val() })));
  reads.push(db.ref(`notification_device_tombstones/${authUid}`).once('value').then((snapshot) => ({ kind: 'tombstone', value: snapshot.val() })));
  if (candidate.source === 'indexed_marketing') {
    reads.push(db.ref(`notification_consents/${authUid}`).once('value').then((snapshot) => ({ kind: 'consent', value: snapshot.val() })));
  }
  countMetric(metrics, 'rtdbDirectReads', reads.length - (candidate.canonicalDeviceLoaded === true ? 1 : 0));
  const values = Object.fromEntries((await Promise.all(reads)).map((entry) => [entry.kind, entry.value]));
  if (values.tombstone?.permanent === true) return { reason: 'device_deleted' };
  if (!values.device || typeof values.device !== 'object') return { reason: 'no_token' };
  if (candidate.source === 'indexed_operational'
    && values.device.operationalTourId !== job.tourId) return { reason: 'stale_audience_index' };
  if (candidate.source === 'indexed_marketing') {
    const membershipRevision = Number(candidate.membership?.registrationRevision || 0);
    if (!isValidMarketingAudienceMembership(candidate.membership)
      || Number(values.device.registrationRevision || 0) !== membershipRevision
      || values.consent?.marketingPreferences?.[job.categoryKey] !== true) {
      return { reason: 'stale_marketing_index' };
    }
  }
  return { candidate: { ...candidate, device: values.device } };
};

/** @param {{ db?: any, job: any, candidate: any }} options */
// eslint-disable-next-line complexity -- one boundary preserves all legacy and indexed eligibility rules
const evaluateAudienceCandidate = async ({ db = admin.database(), job, candidate, nowMs = Date.now(), metrics = null }) => {
  const authUid = String(candidate?.authUid || '').trim();
  countMetric(metrics, 'candidateEvaluations');
  if (!isValidFirebaseKey(authUid)) return { eligible: false, reason: 'invalid_token' };
  let resolvedCandidate = candidate;
  if (isIndexedCandidate(candidate)) {
    const canonical = await loadIndexedCanonicalCandidate({ db, job, candidate, metrics });
    if (canonical.reason) return { eligible: false, reason: canonical.reason };
    resolvedCandidate = canonical.candidate;
  }
  let profile = resolvedCandidate.profile || {};
  const device = normalizeNotificationDevice(resolvedCandidate, profile);
  const baseReason = evaluateCandidateBase(job, authUid, device);
  if (baseReason) return { eligible: false, reason: baseReason, ...(baseReason === 'invalid_token' ? { token: device.pushToken } : {}) };

  const policy = getNotificationDeliveryPolicy(job.notificationType);
  const needsProfile = !resolvedCandidate.profile
    && (job.audienceType !== 'marketing' && job.audienceType !== 'single_installation'
      || (!policy.bypassesOptionalPreferences && policy.preferencePath));
  if (needsProfile) {
    countMetric(metrics, 'rtdbDirectReads');
    profile = (await db.ref(`users/${authUid}`).once('value')).val() || {};
  }
  const authorityReason = await evaluateAudienceAuthority(db, job, authUid, profile, device, nowMs, metrics);
  if (authorityReason) return { eligible: false, reason: authorityReason };

  if (!policy.bypassesOptionalPreferences && policy.preferencePath
    && !readBooleanPath(profile, policy.preferencePath, true)) {
    return { eligible: false, reason: 'opted_out' };
  }

  return {
    eligible: true,
    authUid,
    token: device.pushToken,
    tokenHash: hashPushToken(device.pushToken),
    platform: device.platform,
  };
};

module.exports = {
  DEVICE_MIGRATION_STATE_PATH,
  ELIGIBLE_PERMISSION_STATES,
  PAGE_SIZE,
  decodeAudienceCursor,
  encodeAudienceCursor,
  evaluateAudienceCandidate,
  hashPushToken,
  isOperationsAdmin,
  loadAudienceEvaluationContext,
  loadNotificationAudiencePage,
  normalizeNotificationDevice,
  resolveOperationalAuthority,
};
