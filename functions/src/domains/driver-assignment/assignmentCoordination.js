'use strict';

// @ts-check

const ACTIVE_ASSIGNMENT_ROOT = 'driver_assignment_active/v1';
const DRIVER_ASSIGNMENT_BARRIER_TTL_MS = 5 * 60 * 1000;

/** @type {(...args: any[]) => Promise<any>} */
const acquireDriverAssignmentBarrier = async ({ db, driverId, transitionId, nowMs = Date.now() }) => {
  const path = `${ACTIVE_ASSIGNMENT_ROOT}/${driverId}`;
  const result = await db.ref(path).transaction((current) => {
    if (current?.transitionId && current.transitionId !== transitionId) return undefined;
    const activeLogins = Object.fromEntries(Object.entries(current?.loginAdmissions || {})
      .filter(([, admission]) => Number(admission?.expiresAtMs || 0) > nowMs));
    if (Object.keys(activeLogins).length) return undefined;
    return {
      schemaVersion: 1,
      transitionId,
      createdAtMs: current?.transitionId === transitionId ? current.createdAtMs : nowMs,
      lastRenewedAtMs: nowMs,
      durableUntilExplicitRelease: true,
    };
  }, undefined, false);
  return { acquired: Boolean(result?.committed), path, transitionId };
};

/** @type {(...args: any[]) => Promise<boolean>} */
const releaseDriverAssignmentBarrier = async ({ db, driverId, transitionId }) => {
  const result = await db.ref(`${ACTIVE_ASSIGNMENT_ROOT}/${driverId}`).transaction((current) => (
    current?.transitionId === transitionId ? null : undefined
  ), undefined, false);
  return Boolean(result?.committed);
};

/** @type {(...args: any[]) => Promise<any>} */
const acquireDriverAssignmentLoginAdmission = async ({
  db, driverId, admissionId, authUidHash, nowMs = Date.now(),
}) => {
  const result = await db.ref(`${ACTIVE_ASSIGNMENT_ROOT}/${driverId}`).transaction((current) => {
    if (current?.transitionId) return undefined;
    const loginAdmissions = Object.fromEntries(Object.entries(current?.loginAdmissions || {})
      .filter(([, admission]) => Number(admission?.expiresAtMs || 0) > nowMs));
    loginAdmissions[admissionId] = {
      authUidHash,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + DRIVER_ASSIGNMENT_BARRIER_TTL_MS,
    };
    return { schemaVersion: 1, loginAdmissions };
  }, undefined, false);
  return { acquired: Boolean(result?.committed), admissionId, driverId };
};

/** @type {(...args: any[]) => Promise<boolean>} */
const releaseDriverAssignmentLoginAdmission = async ({ db, driverId, admissionId }) => {
  const result = await db.ref(`${ACTIVE_ASSIGNMENT_ROOT}/${driverId}`).transaction((current) => {
    if (!current?.loginAdmissions?.[admissionId]) return undefined;
    const nextAdmissions = { ...current.loginAdmissions };
    delete nextAdmissions[admissionId];
    return Object.keys(nextAdmissions).length ? { ...current, loginAdmissions: nextAdmissions } : null;
  }, undefined, false);
  return Boolean(result?.committed);
};

/** @param {any} db @param {string} driverId @param {string | null} cursor @param {number} limit */
const readDriverSessionPage = async (db, driverId, cursor, limit) => {
  let query = db.ref('app_sessions').orderByChild('driverId');
  query = cursor ? query.startAt(driverId, cursor).endAt(driverId) : query.equalTo(driverId);
  const snapshot = await query.limitToFirst(limit + 1 + (cursor ? 1 : 0)).once('value');
  const entries = Object.entries(snapshot.val() || {})
    .filter(([authUid]) => authUid !== cursor)
    .sort(([left], [right]) => left.localeCompare(right));
  const page = entries.slice(0, limit);
  return {
    entries: page,
    hasMore: entries.length > limit,
    cursor: page.length ? page[page.length - 1][0] : cursor,
  };
};

module.exports = {
  ACTIVE_ASSIGNMENT_ROOT,
  acquireDriverAssignmentBarrier,
  acquireDriverAssignmentLoginAdmission,
  readDriverSessionPage,
  releaseDriverAssignmentBarrier,
  releaseDriverAssignmentLoginAdmission,
};
