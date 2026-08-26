'use strict';

// @ts-check

const { createHash } = require('node:crypto');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { isValidPushToken, userWantsTourCategoryBroadcast } = require('./notificationPolicy');
const { getNotificationDeliveryPolicy } = require('./notificationDeliveryPolicy');

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
  const value = snapshot.val() || {};
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  const hasMore = entries.length > pageSize;
  const selected = entries.slice(0, pageSize);
  return {
    entries: selected,
    hasMore,
    lastKey: selected.length ? selected[selected.length - 1][0] : after,
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
const isOperationsAdmin = async (db, authUid) => {
  if (authUid === PRIMARY_ADMIN_UID) return true;
  const snapshot = await db.ref(`admin_users/${authUid}`).once('value');
  return snapshot.val() === true;
};

/** @param {any} db @param {string} authUid @param {any} profile @param {string} tourId */
const resolveOperationalAuthority = async (db, authUid, profile, tourId, nowMs = Date.now()) => {
  const sessionSnapshot = await db.ref(`app_sessions/${authUid}`).once('value');
  const session = sessionSnapshot.val();
  if (!isActiveSessionRecord(session, { nowMs }) || session.authUid !== authUid) {
    return { allowed: false, reason: 'inactive_operational_session' };
  }
  if (session.tourId !== tourId) return { allowed: false, reason: 'wrong_tour' };
  if (session.principalType === 'passenger') return resolvePassengerAuthority(db, authUid, tourId, session, nowMs);
  return resolveDriverAuthority(db, authUid, profile, tourId, session);
};
const resolvePassengerAuthority = async (db, authUid, tourId, session, nowMs) => {
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
const resolveDriverAuthority = async (db, authUid, profile, tourId, session) => {
  const driverId = String(session.driverId || profile?.driverId || '').trim();
  if (!isValidFirebaseKey(driverId)) return { allowed: false, reason: 'wrong_tour' };
  const driverSnapshot = await db.ref(`drivers/${driverId}`).once('value');
  const driver = driverSnapshot.val() || {};
  if (driver.authUid !== authUid || driver.currentTourId !== tourId) {
    return { allowed: false, reason: 'wrong_tour' };
  }
  const assignmentSnapshot = await db.ref(`tour_manifests/${tourId}/assigned_drivers/${driverId}`).once('value');
  if (assignmentSnapshot.val() !== true) return { allowed: false, reason: 'wrong_tour' };
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
const evaluateAudienceAuthority = async (db, job, authUid, profile, device, nowMs) => {
  if (job.audienceType === 'marketing') return device.marketingEligible && userWantsTourCategoryBroadcast({ preferences: { marketing: device.marketingPreferences } }, job.categoryKey) ? null : 'opted_out';
  if (job.audienceType === 'single_installation') return null;
  if (job.audienceType === 'safety' && await isOperationsAdmin(db, authUid)) return null;
  if (!device.operationalEligible) return 'inactive_operational_session';
  const authority = await resolveOperationalAuthority(db, authUid, profile, job.tourId, nowMs);
  if (!authority.allowed) return authority.reason || 'wrong_tour';
  if (job.audienceType === 'safety' && authority.role !== 'driver') return 'wrong_tour';
  if (job.senderPrincipalId && authority.session?.principalId === job.senderPrincipalId) return 'sender_excluded';
  return evaluateDriverAudience(job, authority);
};

/** @param {{ db?: any, job: any, candidate: any }} options */
const evaluateAudienceCandidate = async ({ db = admin.database(), job, candidate, nowMs = Date.now() }) => {
  const authUid = String(candidate?.authUid || '').trim();
  if (!isValidFirebaseKey(authUid)) return { eligible: false, reason: 'invalid_token' };
  const profile = candidate.profile || (await db.ref(`users/${authUid}`).once('value')).val() || {};
  const device = normalizeNotificationDevice(candidate, profile);
  const baseReason = evaluateCandidateBase(job, authUid, device);
  if (baseReason) return { eligible: false, reason: baseReason, ...(baseReason === 'invalid_token' ? { token: device.pushToken } : {}) };

  const policy = getNotificationDeliveryPolicy(job.notificationType);
  const authorityReason = await evaluateAudienceAuthority(db, job, authUid, profile, device, nowMs);
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
  loadNotificationAudiencePage,
  normalizeNotificationDevice,
  resolveOperationalAuthority,
};
