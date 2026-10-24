'use strict';

const { randomBytes } = require('node:crypto');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { buildWriteManifest } = loadLegacyLibrary('sessionPublicationAuthority');
const { normalizeTourKeyForComparison } = require('../../infrastructure/validation/stringNormalization');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { derivePassengerAccountDeletionKey } = require('../account-deletion/public');
const ROOT = 'notification_mutation_authority';
const id = () => randomBytes(24).toString('hex');
const changed = () => Object.assign(new Error('Notification publication was superseded'), { code: 'SESSION_CHANGED' });
const capturePassengerSource = async ({ db, authUid, sessionId }) => {
  if (!sessionId) return {};
  const session = (await db.ref(`app_sessions/${authUid}`).once('value')).val();
  if (session?.sessionId !== sessionId) throw changed();
  if (session.principalType !== 'passenger') return {};
  const bookingRef = (await db.ref(`users/${authUid}/bookingRef`).once('value')).val();
  if (!isValidFirebaseKey(bookingRef)) throw changed();
  const booking = (await db.ref(`bookings/${bookingRef}`).once('value')).val();
  const sourceTourId = booking?.tourId;
  if (typeof sourceTourId !== 'string' || !normalizeTourKeyForComparison(sourceTourId)
    || normalizeTourKeyForComparison(sourceTourId) !== normalizeTourKeyForComparison(session.tourId)) throw changed();
  return { bookingRef, sourceTourId, passengerDeletionKey: derivePassengerAccountDeletionKey(bookingRef) };
};
const createNotificationPublisher = ({ db, authUid, authority }) => {
  const admin = require('firebase-admin');
  if (!db.app?.options) throw new Error('A real Firebase Admin Database is required for notification publication');
  const app = admin.initializeApp({ ...db.app.options, databaseAuthVariableOverride: {
    uid: authUid, lltNotificationIssuer: true, notificationEpoch: authority.epoch,
    notificationOperationId: authority.operationId,
  } }, `notification-publisher-${id()}`);
  return { db: app.database(db.app.options.databaseURL), close: () => app.delete() };
};

// All three projections commit together under rules evaluated by the server.
// A queued SDK request cannot outlive session replacement, deletion, or a newer
// notification mutation merely because its local transaction callback ran first.
const publishNotificationMutation = async ({ db, authUid, publication, sessionId, existing,
  tombstone, updates, expiresAtMs, canMutate, createPublisher = createNotificationPublisher }) => {
  const ref = db.ref(`${ROOT}/${authUid}`);
  const captured = (await ref.once('value')).val();
  // Rules compare these raw source fields again when the queued write arrives.
  // Normalization here proves the captured booking belongs to this session;
  // exact equality at commit fences a subsequent transfer without a session sweep.
  const passengerSource = await capturePassengerSource({ db, authUid, sessionId });
  const authority = { schemaVersion: 1, epoch: id(), operationId: id(), state: 'prepared',
    ...passengerSource,
    sessionEpoch: publication?.epoch || null, sessionId: sessionId || null, expiresAtMs,
    expectedRegistrationRevision: Number(existing.registrationRevision || 0),
    expectedTombstoneRevision: Number(tombstone?.registrationRevision || 0),
    writePaths: buildWriteManifest(updates) };
  const prepared = await ref.transaction(current => {
    if (!canMutate()) return undefined;
    if (current === null && captured?.epoch) return null;
    if ((current?.epoch || null) !== (captured?.epoch || null)) return undefined;
    return authority;
  }, undefined, false);
  if (!prepared.committed || prepared.snapshot.val()?.epoch !== authority.epoch) throw changed();
  const publisher = createPublisher({ db, authUid, authority });
  try {
    await publisher.db.ref().update({ ...updates, [`${ROOT}/${authUid}/state`]: 'committed' });
  } catch (error) {
    const current = (await ref.once('value')).val();
    if (current?.epoch !== authority.epoch || current.state !== 'committed') throw error;
  } finally { await publisher.close(); }
  const current = (await ref.once('value')).val();
  if (current?.epoch !== authority.epoch || current.state !== 'committed') throw changed();
};

module.exports = { ROOT, createNotificationPublisher, publishNotificationMutation };
