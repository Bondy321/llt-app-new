'use strict';

const { randomBytes } = require('crypto');

const APP_SESSION_SCHEMA_VERSION = 1;
const APP_SESSION_ID_PATTERN = /^sess_v1_[a-f0-9]{32}$/;
const PASSENGER_PRINCIPAL_PATTERN = /^pax_v2_[a-f0-9]{32}$/;
const DRIVER_PRINCIPAL_PATTERN = /^driver:[^.#$\/\[\]\x00-\x1F\x7F]{1,120}$/;
const FIREBASE_KEY_PATTERN = /^[^.#$\/\[\]\x00-\x1F\x7F]{1,160}$/;

const PASSENGER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DRIVER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const UNASSIGNED_DRIVER_SESSION_TTL_MS = 60 * 60 * 1000;
const MIN_SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const createAppSessionId = (randomBytesFn = randomBytes) => (
  `sess_v1_${randomBytesFn(16).toString('hex')}`
);

const isValidAppSessionId = (value) => (
  typeof value === 'string' && APP_SESSION_ID_PATTERN.test(value)
);

const isValidFirebaseKey = (value) => (
  typeof value === 'string' && FIREBASE_KEY_PATTERN.test(value)
);

const isValidPassengerPrincipal = (value) => (
  typeof value === 'string' && PASSENGER_PRINCIPAL_PATTERN.test(value)
);

const isValidDriverPrincipal = (value, driverId = null) => (
  typeof value === 'string'
  && DRIVER_PRINCIPAL_PATTERN.test(value)
  && (!driverId || value === `driver:${driverId}`)
);

const calculateSessionExpiry = ({
  principalType,
  tourId = null,
  nowMs = Date.now(),
  ttlMs,
} = {}) => {
  const defaultTtl = principalType === 'passenger'
    ? PASSENGER_SESSION_TTL_MS
    : (tourId ? DRIVER_SESSION_TTL_MS : UNASSIGNED_DRIVER_SESSION_TTL_MS);
  const requestedTtl = Number.isFinite(ttlMs) ? ttlMs : defaultTtl;
  const boundedTtl = Math.min(MAX_SESSION_TTL_MS, Math.max(MIN_SESSION_TTL_MS, requestedTtl));
  return Math.trunc(nowMs) + Math.trunc(boundedTtl);
};

const assertCommonSessionInput = ({ authUid, sessionId, principalId, principalType, tourId, nowMs, expiresAtMs }) => {
  if (!isValidFirebaseKey(authUid)) throw new Error('Invalid app session auth UID');
  if (!isValidAppSessionId(sessionId)) throw new Error('Invalid app session ID');
  if (principalType !== 'passenger' && principalType !== 'driver') throw new Error('Invalid app session role');
  if (tourId !== null && !isValidFirebaseKey(tourId)) throw new Error('Invalid app session tour');
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('Invalid app session issue time');
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) throw new Error('Invalid app session expiry');
  if (principalType === 'passenger' && !isValidPassengerPrincipal(principalId)) {
    throw new Error('Invalid passenger principal');
  }
};

const buildPassengerSessionRecord = ({
  authUid,
  principalId,
  tourId,
  sessionId = createAppSessionId(),
  nowMs = Date.now(),
  expiresAtMs = calculateSessionExpiry({ principalType: 'passenger', tourId, nowMs }),
  sessionRevision = 1,
} = {}) => {
  assertCommonSessionInput({ authUid, sessionId, principalId, principalType: 'passenger', tourId, nowMs, expiresAtMs });
  if (!tourId) throw new Error('Passenger session requires a tour');
  return {
    schemaVersion: APP_SESSION_SCHEMA_VERSION,
    sessionId,
    authUid,
    principalId,
    principalType: 'passenger',
    tourId,
    driverId: null,
    status: 'active',
    issuedAtMs: nowMs,
    lastAuthenticatedAtMs: nowMs,
    expiresAtMs,
    sessionRevision,
  };
};

const buildDriverSessionRecord = ({
  authUid,
  driverId,
  tourId = null,
  driverLoginPolicyGeneration = 0,
  sessionId = createAppSessionId(),
  nowMs = Date.now(),
  expiresAtMs = calculateSessionExpiry({ principalType: 'driver', tourId, nowMs }),
  sessionRevision = 1,
} = {}) => {
  const principalId = `driver:${driverId}`;
  assertCommonSessionInput({ authUid, sessionId, principalId, principalType: 'driver', tourId, nowMs, expiresAtMs });
  if (!isValidFirebaseKey(driverId) || !isValidDriverPrincipal(principalId, driverId)) {
    throw new Error('Invalid driver principal');
  }
  if (!Number.isSafeInteger(driverLoginPolicyGeneration) || driverLoginPolicyGeneration < 0) {
    throw new Error('Invalid driver login policy generation');
  }
  return {
    schemaVersion: APP_SESSION_SCHEMA_VERSION,
    sessionId,
    authUid,
    principalId,
    principalType: 'driver',
    tourId,
    driverId,
    driverLoginPolicyGeneration,
    status: 'active',
    issuedAtMs: nowMs,
    lastAuthenticatedAtMs: nowMs,
    expiresAtMs,
    sessionRevision,
  };
};

const buildPassengerParticipantRecord = ({ session, joinedAtMs = session?.issuedAtMs } = {}) => {
  if (!session || session.principalType !== 'passenger' || !isValidAppSessionId(session.sessionId)) {
    throw new Error('Valid passenger session required');
  }
  return {
    schemaVersion: 2,
    userId: session.authUid,
    principalId: session.principalId,
    sessionId: session.sessionId,
    sessionExpiresAtMs: session.expiresAtMs,
    joinedAtMs,
    lastAuthenticatedAtMs: session.lastAuthenticatedAtMs,
  };
};

const isActiveSessionRecord = (session, { nowMs = Date.now() } = {}) => {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return false;
  if (session.schemaVersion !== APP_SESSION_SCHEMA_VERSION || session.status !== 'active') return false;
  if (!isValidAppSessionId(session.sessionId) || !isValidFirebaseKey(session.authUid)) return false;
  if (!Number.isSafeInteger(session.expiresAtMs) || session.expiresAtMs <= nowMs) return false;
  if (!Number.isSafeInteger(session.issuedAtMs) || !Number.isSafeInteger(session.lastAuthenticatedAtMs)) return false;
  if (!Number.isSafeInteger(session.sessionRevision) || session.sessionRevision < 1) return false;
  if (session.principalType === 'passenger') {
    return isValidPassengerPrincipal(session.principalId)
      && isValidFirebaseKey(session.tourId)
      && session.driverId === null;
  }
  if (session.principalType === 'driver') {
    return isValidFirebaseKey(session.driverId)
      && isValidDriverPrincipal(session.principalId, session.driverId)
      && (!Object.prototype.hasOwnProperty.call(session, 'driverLoginPolicyGeneration')
        || (Number.isSafeInteger(session.driverLoginPolicyGeneration)
          && session.driverLoginPolicyGeneration >= 0))
      && (session.tourId === null || isValidFirebaseKey(session.tourId));
  }
  return false;
};

const toClientSession = (session) => ({
  schemaVersion: session.schemaVersion,
  sessionId: session.sessionId,
  tourId: session.tourId,
  principalId: session.principalId,
  principalType: session.principalType,
  driverId: session.driverId,
  issuedAtMs: session.issuedAtMs,
  expiresAtMs: session.expiresAtMs,
  sessionRevision: session.sessionRevision,
});

module.exports = {
  APP_SESSION_SCHEMA_VERSION,
  APP_SESSION_ID_PATTERN,
  PASSENGER_SESSION_TTL_MS,
  DRIVER_SESSION_TTL_MS,
  UNASSIGNED_DRIVER_SESSION_TTL_MS,
  createAppSessionId,
  isValidAppSessionId,
  isValidFirebaseKey,
  isValidPassengerPrincipal,
  isValidDriverPrincipal,
  calculateSessionExpiry,
  buildPassengerSessionRecord,
  buildDriverSessionRecord,
  buildPassengerParticipantRecord,
  isActiveSessionRecord,
  toClientSession,
};
