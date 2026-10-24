'use strict';

const { randomUUID } = require('node:crypto');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { normalizeTourKeyForComparison } = require('../../infrastructure/validation/stringNormalization');
const { derivePassengerAccountDeletionKey } = require('../account-deletion/public');
const changed = () => Object.assign(new Error('Media publication was superseded'), { code: 'MEDIA_AUTHORITY_CHANGED' });

const assertCapturedSessionAuthority = (authority, session) => {
  if (authority?.schemaVersion !== 1 || authority.state !== 'committed'
    || !/^[a-f0-9]{48}$/.test(authority.epoch || '') || authority.sessionId !== session?.sessionId) throw changed();
};
const assertCapturedPassengerBooking = (booking, tourId) => {
  if (normalizeTourKeyForComparison(booking?.tourId) !== tourId || booking?.loginEligible === false
    || (booking.sourceRoster && booking.sourceRoster.state !== 'active')) throw changed();
};

const captureMediaPublicationAuthority = async ({ db, access, authUid, tourId }) => {
  if (!access?.allowed || !isValidFirebaseKey(authUid) || !isValidFirebaseKey(tourId)) throw changed();
  const lifecycle = (await db.ref(`sync_roster_control/${tourId}/lifecycle`).once('value')).val();
  if (['deleting', 'deleted'].includes(lifecycle?.state)) throw changed();
  const captured = { tourGeneration: lifecycle?.generation || null };
  if (access.role === 'admin') return { ...captured, adminMfa: true };
  const authority = (await db.ref(`app_session_authority/${authUid}`).once('value')).val();
  assertCapturedSessionAuthority(authority, access.session);
  Object.assign(captured, { authorityEpoch: authority.epoch, sessionId: access.session.sessionId,
    sessionRevision: access.session.sessionRevision });
  if (access.role === 'passenger') {
    const bookingRef = (await db.ref(`users/${authUid}/bookingRef`).once('value')).val();
    if (!isValidFirebaseKey(bookingRef)) throw changed();
    const booking = (await db.ref(`bookings/${bookingRef}`).once('value')).val();
    assertCapturedPassengerBooking(booking, tourId);
    Object.assign(captured, { bookingRef, sourceTourId: booking.tourId,
      passengerDeletionKey: derivePassengerAccountDeletionKey(bookingRef) });
  }
  return captured;
};

const mediaOperationPaths = operation => {
  const { visibility, tourId, ownerKey, photoId, authUid, operationId } = operation;
  if (![tourId, photoId, authUid, operationId].every(isValidFirebaseKey)
    || !['group', 'private'].includes(visibility) || (visibility === 'private' && !isValidFirebaseKey(ownerKey))) throw changed();
  return {
    recordPath: visibility === 'group' ? `group_tour_photos/${tourId}/${photoId}` : `private_tour_photos/${tourId}/${ownerKey}/${photoId}`,
    lockPath: `media_record_locks/v1/${visibility}/${tourId}/${visibility === 'private' ? ownerKey : '_group'}/${photoId}`,
    operationPath: `media_upload_operations/${authUid}/${operationId}`,
  };
};

const createMediaPublisher = ({ db, operation, lockOwner, phase }) => {
  const admin = require('firebase-admin');
  if (!db.app?.options) throw new Error('Real Admin database required for media publication');
  const app = admin.initializeApp({ ...db.app.options, databaseAuthVariableOverride: {
    uid: operation.authUid, lltMediaPublisher: true, mediaOperationId: operation.operationId,
    mediaLockOwner: lockOwner, mediaPhase: phase,
  } }, `media-publisher-${randomUUID()}`);
  return { db: app.database(), close: () => app.delete() };
};

const assertMediaPublicationRecord = ({ operation, lockOwner, record, phase }) => {
  if (!['reserve', 'finalize'].includes(phase) || !isValidFirebaseKey(lockOwner)
    || !record || Buffer.byteLength(JSON.stringify(record)) > 16384
    || record.userId !== operation.principalId || record.storagePath !== operation.storagePath
    || record._upload?.operationId !== operation.operationId || record._upload?.authUid !== operation.authUid
    || record._upload?.status !== (phase === 'reserve' ? 'pending' : 'complete')) throw changed();
};

const commitMediaPublication = async ({ db, operation, lockOwner, record, phase,
  createPublisher = createMediaPublisher }) => {
  const { recordPath, operationPath } = mediaOperationPaths(operation);
  assertMediaPublicationRecord({ operation, lockOwner, record, phase });
  const state = phase === 'reserve' ? 'reserved' : 'committed';
  const publisher = createPublisher({ db, operation, lockOwner, phase });
  try {
    await publisher.db.ref().update({ [recordPath]: record, [`${operationPath}/state`]: state,
      ...(phase === 'finalize' ? { [`media_upload_cleanup_queue/${operation.operationId}`]: null } : {}) });
  } finally { await publisher.close(); }
  const current = (await db.ref(operationPath).once('value')).val();
  if (current?.state !== state) throw changed();
};

// This writer receives ordinary user permissions, never a root write grant.
// The extra server-only marker further constrains already-queued work to the
// original session and exact still-readable photo at server commit.
const createScopedMediaChatPublisher = async ({ db, authUid, access, claims = {}, tourId, photoId, photo }) => {
  const captured = await captureMediaPublicationAuthority({ db, authUid, access, tourId });
  const admin = require('firebase-admin');
  const app = admin.initializeApp({ ...db.app.options, databaseAuthVariableOverride: {
    uid: authUid, token: claims, lltMediaChatWriter: true, mediaTourId: tourId, mediaPhotoId: photoId,
    mediaExpiresAtMs: Date.now() + 30000, mediaTourGeneration: captured.tourGeneration,
    mediaStoragePath: photo.storagePath, mediaPhotoOwner: photo.userId,
    mediaUploadOperationId: photo._upload?.operationId || null,
    mediaAdmin: access.role === 'admin', mediaAuthorityEpoch: captured.authorityEpoch || null,
    mediaSessionId: captured.sessionId || null, mediaSessionRevision: captured.sessionRevision || null,
    mediaPassengerDeletionKey: captured.passengerDeletionKey || null,
  } }, `media-chat-writer-${randomUUID()}`);
  return { db: app.database(), close: () => app.delete() };
};

module.exports = { captureMediaPublicationAuthority, mediaOperationPaths, createMediaPublisher, commitMediaPublication, createScopedMediaChatPublisher };
