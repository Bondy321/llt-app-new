'use strict';

const { randomUUID } = require('node:crypto');
const admin = require('firebase-admin');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');

const tourRoots = new Set(['tours', 'tour_manifests', 'pickupPoints', 'chats', 'internal_chats',
  'group_tour_photos', 'private_tour_photos', 'broadcasts', 'tour_notifications', 'notification_read_state',
  'notification_read_migration_requests', 'notification_read_legacy_cleanup_queue', 'tour_access_grants',
  'safety_submission_locks', 'driver_location_pickups', 'driver_location_projection_state', 'sync_roster_control']);
const bookingRoots = new Set(['bookings', 'booking_identities', 'passenger_identity_security', 'booking_access_grants']);
const isScopedSupportPath = ({ root, id, field, parts, value, scope, bookings }) => {
  if (root === 'manual_booking_creation_locks') return (id === 'tours' && scope.has(field)) || (id === 'bookings' && bookings.has(field));
  if (root === 'driver_assignment_locks') return id === 'tours' && scope.has(field) && value === null;
  if (root === 'passenger_trip_signals') return id === 'v1' && ((field === 'bookings' && bookings.has(parts[3])) || (field === 'tours' && scope.has(parts[3])));
  return false;
};
const isScopedCleanupPath = ({ root, field, parts, value, scope }) => {
  if (root === 'drivers') return value === null && (['currentTourId', 'currentTourCode'].includes(field)
    || (field === 'assignments' && scope.has(parts[3])));
  if (root === 'users') return (field === 'driverAssignedTourId' && value === null)
    || (field === 'lastUpdated' && Number.isSafeInteger(value));
  return ['content_reports', 'globalSafetyAlerts', 'driver_location_sessions'].includes(root) && parts.length === 2 && value === null;
};
const validatePublicationPaths = ({ tourIds, bookingRefs = [], updates }) => {
  const scope = new Set(tourIds);
  const bookings = new Set(bookingRefs);
  for (const [path, value] of Object.entries(updates)) {
    const parts = path.split('/');
    if (parts.length < 2 || !parts.every(isValidFirebaseKey)) throw new Error('Invalid tour publication path');
    const [root, id, field] = parts;
    if (tourRoots.has(root) && scope.has(id)) continue;
    if (bookingRoots.has(root) && bookings.has(id)) {
      const destination = field === 'tourId' ? value : value?.tourId;
      if (root === 'bookings' && destination != null && !scope.has(destination)) throw new Error('Booking outside tour publication scope');
      continue;
    }
    const candidate = { root, id, field, parts, value, scope, bookings };
    if (isScopedSupportPath(candidate) || isScopedCleanupPath(candidate)) continue;
    throw new Error('Path outside tour publication contract');
  }
};

const createTourPublisher = ({ db, tourIds, owner }) => {
  const ids = [...new Set(tourIds)].sort();
  if (!ids.length || ids.length > 16 || !ids.every(isValidFirebaseKey) || !isValidFirebaseKey(owner)) {
    throw new Error('Invalid tour publication scope');
  }
  if (!db.app?.options) throw new Error('Tour publication requires a real Admin SDK database');
  const app = admin.initializeApp({ ...db.app.options,
    databaseAuthVariableOverride: { uid: 'llt-tour-publisher', lltTourPublisher: true,
      owner, tourCount: ids.length, ...Object.fromEntries(ids.map((id, index) => [`tour${index}`, id])) },
  }, `tour-publisher-${randomUUID()}`);
  // Preserve the configured namespace. ref().toString() on an emulator is an
  // HTTP URL without its ns parameter, so passing it back selects another DB.
  return { database: app.database(), close: () => app.delete() };
};

const commitTourPublication = async ({ db, tourIds, bookingRefs = [], owner, updates, createPublisher = createTourPublisher }) => {
  if (!updates || Object.keys(updates).length > 12000 || Buffer.byteLength(JSON.stringify(updates)) > 8 * 1024 * 1024) {
    throw new Error('Tour publication exceeds its bounded write budget');
  }
  validatePublicationPaths({ tourIds, bookingRefs, updates });
  const publisher = createPublisher({ db, tourIds, owner });
  try { await publisher.database.ref().update(updates); }
  finally { await publisher.close(); }
};

module.exports = { createTourPublisher, commitTourPublication, validatePublicationPaths };
