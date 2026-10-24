'use strict';

const { randomBytes } = require('node:crypto');
const { normalizeTourKeyForComparison } = require('../src/infrastructure/validation/stringNormalization');
const { readSourceRoster } = require('../src/domains/manifests/sourceRoster');

const ROOT = 'app_session_authority';
const TOKEN_TTL_MS = 180000;
const randomId = () => randomBytes(24).toString('hex');
const changed = () => Object.assign(new Error('Session publication was superseded'), { code: 'SESSION_CHANGED' });
const epochOf = value => value?.epoch || null;
const validAuthority = value => value && typeof value === 'object' && !Array.isArray(value)
  && value.schemaVersion === 1 && /^[a-f0-9]{48}$/.test(value.epoch || '')
  && ['prepared', 'committed', 'blocked', 'deletion_prepared', 'deleted'].includes(value.state);

// Persistent installation fence. This node is never garbage-collected with a
// session: an absent canonical session must not make an old operation current.
const captureInstallationAuthority = async ({ db, authUid }) => {
  const value = (await db.ref(`${ROOT}/${authUid}`).once('value')).val();
  if (value !== null && value !== undefined && !validAuthority(value)) throw changed();
  if (['deleted', 'deletion_prepared'].includes(value?.state)) throw Object.assign(changed(), { code: 'ACCOUNT_DELETION_IN_PROGRESS' });
  return { epoch: epochOf(value), value };
};

const supersedeInstallationAuthority = async ({ db, authUid, expectedSessionId, deleted = false,
  reason = 'session_ended', nowMs = Date.now() }) => {
  const epoch = randomId();
  const result = await db.ref(`${ROOT}/${authUid}`).transaction(current => {
    if (current !== null && !validAuthority(current)) return undefined;
    if (['deleted', 'deletion_prepared'].includes(current?.state)) return current;
    if (current && expectedSessionId && current.sessionId !== expectedSessionId
      && !(current.state === 'prepared' && current.previousSessionId === expectedSessionId)) return undefined;
    return { schemaVersion: 1, epoch, state: deleted ? 'deleted' : 'blocked',
      reason, updatedAtMs: nowMs, previousSessionId: expectedSessionId || null };
  }, undefined, false);
  if (!result.committed) throw changed();
  return result.snapshot.val();
};

const buildWriteManifest = updates => {
  if (!updates || typeof updates !== 'object' || Object.keys(updates).length > 120
    || Buffer.byteLength(JSON.stringify(updates)) > 128 * 1024) throw new Error('Issuance publication exceeds bounded scope');
  const manifest = {};
  for (const path of Object.keys(updates)) {
    const parts = path.split('/');
    if (parts.length < 2 || parts.some(part => !part || /[.#$\[\]\u0000-\u001f\u007f]/.test(part))) {
      throw new Error('Invalid issuance write path');
    }
    let node = manifest;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) node[part] = true;
      else { node[part] ||= {}; node = node[part]; }
    });
  }
  return manifest;
};

const capturePassengerBooking = async ({ db, authUid, session, updates }) => {
  if (session.principalType !== 'passenger') return null;
  const bookingRef = updates[`users/${authUid}/bookingRef`];
  if (typeof bookingRef !== 'string' || /[.#$/\[\]]/.test(bookingRef)) throw changed();
  const booking = (await db.ref(`bookings/${bookingRef}`).once('value')).val();
  let roster;
  try { roster = readSourceRoster(booking); } catch { throw changed(); }
  if (!booking || normalizeTourKeyForComparison(booking.tourId) !== normalizeTourKeyForComparison(session.tourId)
    || booking.loginEligible === false || (roster && roster.state !== 'active')) throw changed();
  return { bookingRef, sourceTourId: booking.tourId };
};

const prepareSessionPublication = async ({ db, authUid, capturedAuthority, session, updates,
  operationId = randomId(), previousSessionId = null, staff = null, nowMs = Date.now() }) => {
  if (!capturedAuthority || !Object.prototype.hasOwnProperty.call(capturedAuthority, 'epoch')) throw changed();
  const passengerBooking = await capturePassengerBooking({ db, authUid, session, updates });
  const prepared = { schemaVersion: 1, epoch: randomId(), operationId, state: 'prepared',
    sessionId: session.sessionId, previousSessionId, createdAtMs: nowMs,
    lockOwner: updates[`app_session_locks/${authUid}`]?.owner || null,
    expiresAtMs: nowMs + TOKEN_TTL_MS, writePaths: buildWriteManifest(updates),
    publication: { session, updatesJson: JSON.stringify(updates) },
    ...(staff ? { staff } : {}), ...(passengerBooking ? { passengerBooking } : {}) };
  const result = await db.ref(`${ROOT}/${authUid}`).transaction(current => {
    if (current === null && capturedAuthority.epoch !== null) return null; // cold-cache compare/retry
    if (current !== null && !validAuthority(current)) return undefined;
    if (['deleted', 'deletion_prepared'].includes(current?.state) || epochOf(current) !== capturedAuthority.epoch) return undefined;
    return prepared;
  }, undefined, false);
  if (!result.committed || result.snapshot.val()?.operationId !== operationId) throw changed();
  return prepared;
};

// Firebase's supported limited-privilege Admin SDK connection deliberately
// evaluates rules at SERVER COMMIT, including for an update queued offline.
// auth.lltSessionIssuer is a top-level override member; Firebase ID-token custom
// claims are under auth.token and cannot manufacture this server identity.
const createRestrictedIssuer = ({ db, authUid, authority }) => {
  const admin = require('firebase-admin');
  const parent = db.app;
  if (!parent?.options) throw new Error('A real Firebase Admin Database is required for publication');
  const app = admin.initializeApp({ ...parent.options,
    databaseAuthVariableOverride: { uid: authUid, lltSessionIssuer: true,
      issuanceOperationId: authority.operationId, issuanceEpoch: authority.epoch },
  }, `session-issuer-${randomId()}`);
  return { db: app.database(parent.options.databaseURL), close: () => app.delete() };
};

const commitSessionPublication = async ({ db, authUid, authority, session, updates,
  createIssuer = createRestrictedIssuer }) => {
  const issuer = createIssuer({ db, authUid, authority });
  try {
    await issuer.db.ref().update({ ...updates, [`${ROOT}/${authUid}/state`]: 'committed',
      [`${ROOT}/${authUid}/publication`]: null, [`${ROOT}/${authUid}/writePaths`]: null,
      [`${ROOT}/${authUid}/passengerBooking`]: null });
  } catch (error) {
    // A lost acknowledgement is recoverable only for this exact committed
    // operation and canonical session. Never report a successor as our success.
    const [current, canonical] = await Promise.all([
      db.ref(`${ROOT}/${authUid}`).once('value'), db.ref(`app_sessions/${authUid}`).once('value'),
    ]);
    if (current.val()?.epoch !== authority.epoch || current.val()?.state !== 'committed'
      || canonical.val()?.sessionId !== session.sessionId) throw error;
  } finally { await issuer.close(); }
  const [current, canonical] = await Promise.all([
    db.ref(`${ROOT}/${authUid}`).once('value'), db.ref(`app_sessions/${authUid}`).once('value'),
  ]);
  if (current.val()?.epoch !== authority.epoch || current.val()?.state !== 'committed'
    || canonical.val()?.sessionId !== session.sessionId) throw changed();
};

// This durable intent is itself a login barrier. If the atomic job publication
// fails, only the exact accepted receipt can resume its captured server scope.
const prepareDeletionPublication = async ({ db, authUid, expectedSessionId, deletionId, job,
  updates, lockOwner, capturedAuthority, nowMs = Date.now() }) => {
  const prepared = { schemaVersion: 1, epoch: randomId(), operationId: randomId(),
    state: 'deletion_prepared', sessionId: expectedSessionId, deletionId, lockOwner,
    createdAtMs: nowMs, writePaths: buildWriteManifest(updates),
    deletionPublication: { job, updatesJson: JSON.stringify(updates) } };
  const result = await db.ref(`${ROOT}/${authUid}`).transaction(current => {
    if (current === null && capturedAuthority.epoch !== null) return null;
    if (current !== null && !validAuthority(current)) return undefined;
    if (current?.state === 'deletion_prepared' && current.deletionId === deletionId) return current;
    if (current?.state === 'deleted' || epochOf(current) !== capturedAuthority.epoch) return undefined;
    if (current?.sessionId && current.sessionId !== expectedSessionId
      && !(current.state === 'prepared' && current.previousSessionId === expectedSessionId)) return undefined;
    return prepared;
  }, undefined, false);
  if (!result.committed || result.snapshot.val()?.deletionId !== deletionId) throw changed();
  return result.snapshot.val();
};

const commitDeletionPublication = async ({ db, authUid, authority, createIssuer = createRestrictedIssuer }) => {
  const { updatesJson, job } = authority.deletionPublication || {};
  if (!job || job.deletionId !== authority.deletionId || job.privateScope?.authUid !== authUid) throw changed();
  const issuer = createIssuer({ db, authUid, authority });
  try {
    await issuer.db.ref().update({ ...JSON.parse(updatesJson), [`${ROOT}/${authUid}/state`]: 'deleted',
      [`${ROOT}/${authUid}/deletionPublication`]: null, [`${ROOT}/${authUid}/writePaths`]: null });
  } catch (error) {
    const current = (await db.ref(`${ROOT}/${authUid}`).once('value')).val();
    if (current?.epoch !== authority.epoch || current.state !== 'deleted') throw error;
  } finally { await issuer.close(); }
  const currentJob = (await db.ref(`account_deletion_jobs/v1/${authority.deletionId}`).once('value')).val();
  if (!currentJob) throw changed();
  return currentJob;
};

module.exports = { ROOT, TOKEN_TTL_MS, captureInstallationAuthority, supersedeInstallationAuthority,
  buildWriteManifest, prepareSessionPublication, createRestrictedIssuer, commitSessionPublication, prepareDeletionPublication, commitDeletionPublication };
