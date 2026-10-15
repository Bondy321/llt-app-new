'use strict';

const { randomUUID } = require('node:crypto');
// Keep this server-owned fence beside driverLocation so one exact-tour CAS can
// prove its generation and write the public leaf atomically, including during
// compatibility. A separate private-state pre-read cannot provide that proof.
// The opaque epoch prevents delete/recreate ABA when numeric counters reset.
const TOUR_FENCE_FIELD = 'driverLocationProjectionRevision';
const TOUR_EPOCH_FIELD = 'driverLocationProjectionEpoch';
const LEASE_MS = 30_000;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const valueOf = snapshot => snapshot?.val?.() ?? null;
const failure = code => Object.assign(new Error(code), { code });

function revision(value) {
  if (value === null || value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw failure('DRIVER_LOCATION_PROJECTION_STATE_INVALID');
  return value;
}
function nextRevision(...values) {
  const current = Math.max(...values.map(revision));
  if (current === Number.MAX_SAFE_INTEGER) throw failure('DRIVER_LOCATION_PROJECTION_STATE_INVALID');
  return current + 1;
}
function epoch(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) {
    throw failure('DRIVER_LOCATION_PROJECTION_STATE_INVALID');
  }
  return value;
}
const owns = (state, lease) => object(state) && state.leaseOwner === lease.leaseOwner
  && state.leaseRevision === lease.leaseRevision && state.leaseToken === lease.leaseToken;
const currentTime = clock => {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - LEASE_MS) {
    throw failure('DRIVER_LOCATION_PROJECTION_STATE_INVALID');
  }
  return now;
};

async function claimProjectionFence({ database, tourId, leaseOwner, clock }) {
  const tourRef = database.ref(`tours/${tourId}`);
  const tour = valueOf(await (typeof tourRef.get === 'function' ? tourRef.get() : tourRef.once('value')));
  if (!object(tour)) return null;
  const tourRevision = revision(tour[TOUR_FENCE_FIELD]);
  epoch(tour[TOUR_EPOCH_FIELD]);
  const publicRevision = revision(tour.driverLocation?.projectionRevision);
  const stateRef = database.ref(`driver_location_projection_state/${tourId}`);
  const leaseToken = randomUUID(); // Allocate once, never inside a retry callback.
  const claimed = await stateRef.transaction(current => {
    if (current !== null && !object(current)) throw failure('DRIVER_LOCATION_PROJECTION_STATE_INVALID');
    const state = current || {};
    const now = currentTime(clock);
    if (state.leaseOwner && Number(state.leaseExpiresAtMs) > now) return undefined;
    return { ...state, leaseOwner, leaseToken, leaseRevision: nextRevision(state.leaseRevision),
      leaseExpiresAtMs: now + LEASE_MS, revision: nextRevision(state.revision, tourRevision, publicRevision) };
  }, undefined, false);
  const lease = valueOf(claimed.snapshot);
  if (!claimed.committed || lease?.leaseOwner !== leaseOwner) throw failure('DRIVER_LOCATION_PROJECTION_BUSY');
  try {
    const reserved = await tourRef.transaction(current => {
      if (!object(current)) return current;
      if (currentTime(clock) >= lease.leaseExpiresAtMs) return undefined;
      epoch(current[TOUR_EPOCH_FIELD]);
      if (revision(current[TOUR_FENCE_FIELD]) >= lease.revision
        || revision(current.driverLocation?.projectionRevision) >= lease.revision) return undefined;
      return { ...current, [TOUR_FENCE_FIELD]: lease.revision, [TOUR_EPOCH_FIELD]: lease.leaseToken };
    }, undefined, false);
    const stored = valueOf(reserved.snapshot);
    if (!object(stored)) { await releaseProjectionFence({ stateRef, lease }); return null; }
    if (!reserved.committed || stored[TOUR_FENCE_FIELD] !== lease.revision
      || stored[TOUR_EPOCH_FIELD] !== lease.leaseToken) {
      throw failure('DRIVER_LOCATION_PROJECTION_SUPERSEDED');
    }
    return { stateRef, tourRef, lease };
  } catch (error) {
    await releaseProjectionFence({ stateRef, lease }).catch(() => {});
    throw error;
  }
}

async function refreshProjectionFence({ stateRef, lease, clock }) {
  const refreshed = await stateRef.transaction(current => {
    if (current === null) return current;
    const now = currentTime(clock);
    if (!owns(current, lease) || revision(current.revision) !== lease.revision
      || current.leaseExpiresAtMs <= now) return undefined;
    return { ...current, leaseExpiresAtMs: now + LEASE_MS };
  }, undefined, false);
  const stored = valueOf(refreshed.snapshot);
  if (!refreshed.committed || !owns(stored, lease)
    || stored.leaseExpiresAtMs <= currentTime(clock)) throw failure('DRIVER_LOCATION_PROJECTION_SUPERSEDED');
  return stored;
}

async function publishProjectionFence({ tourRef, lease, publicProjection, clock }) {
  const result = await tourRef.transaction(current => {
    if (!object(current)) return current;
    if (currentTime(clock) >= lease.leaseExpiresAtMs
      || revision(current[TOUR_FENCE_FIELD]) !== lease.revision
      || epoch(current[TOUR_EPOCH_FIELD]) !== lease.leaseToken) return undefined;
    return { ...current, driverLocation: publicProjection };
  }, undefined, false);
  const stored = valueOf(result.snapshot);
  if (!object(stored)) return { published: false, reason: 'TOUR_MISSING' };
  if (!result.committed || stored[TOUR_FENCE_FIELD] !== lease.revision
    || stored[TOUR_EPOCH_FIELD] !== lease.leaseToken) {
    throw failure('DRIVER_LOCATION_PROJECTION_SUPERSEDED');
  }
  return { published: true };
}

async function releaseProjectionFence({ stateRef, lease, fingerprint, projectedAtMs }) {
  await stateRef.transaction(current => {
    if (current === null) return current;
    if (!owns(current, lease)) return undefined;
    const next = { ...current };
    delete next.leaseOwner;
    delete next.leaseExpiresAtMs;
    delete next.leaseToken;
    if (fingerprint !== undefined) Object.assign(next, { fingerprint, projectedAtMs });
    return next;
  }, undefined, false);
}

module.exports = { TOUR_FENCE_FIELD, TOUR_EPOCH_FIELD, claimProjectionFence, refreshProjectionFence,
  publishProjectionFence, releaseProjectionFence };
