'use strict';

// @ts-check

const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { buildPhotoVariantPaths, parseSourcePhotoPath } = require('../media/public');
const { normalizeTourKeyForComparison, resolveTrimmedString } = require('../../infrastructure/validation/stringNormalization');

/** @type {(...args: any[]) => any} */
const buildTourDeletionUpdates = ({
  tourId,
  bookings = {},
  drivers = {},
  driverUsers = {},
  contentReports = {},
  globalSafetyAlerts = {},
}) => {
  /** @type {Record<string, any>} */
  const updates = {
    [`tours/${tourId}`]: null,
    [`tour_manifests/${tourId}`]: null,
    [`pickupPoints/${tourId}`]: null,
    [`chats/${tourId}`]: null,
    [`internal_chats/${tourId}`]: null,
    [`group_tour_photos/${tourId}`]: null,
    [`private_tour_photos/${tourId}`]: null,
    [`broadcasts/${tourId}`]: null,
    [`tour_notifications/${tourId}`]: null,
    [`notification_read_state/${tourId}`]: null,
    [`notification_read_migration_requests/${tourId}`]: null,
    [`notification_read_legacy_cleanup_queue/${tourId}`]: null,
    [`tour_access_grants/${tourId}`]: null,
    [`manual_booking_creation_locks/tours/${tourId}`]: null,
    [`driver_assignment_locks/tours/${tourId}`]: null,
    [`safety_submission_locks/${tourId}`]: null,
  };

  Object.keys(bookings).forEach((bookingRef) => {
    updates[`bookings/${bookingRef}`] = null;
    updates[`booking_identities/${bookingRef}`] = null;
    updates[`passenger_identity_security/${bookingRef}`] = null;
    updates[`booking_access_grants/${bookingRef}`] = null;
    updates[`manual_booking_creation_locks/bookings/${bookingRef}`] = null;
  });

  Object.entries(drivers).forEach(([driverId, driver = {}]) => {
    const currentTourId = normalizeTourKeyForComparison(driver.currentTourId);
    const assignmentKeys = Object.keys(driver.assignments || {});
    assignmentKeys.forEach((candidate) => {
      if (normalizeTourKeyForComparison(candidate) === tourId) {
        updates[`drivers/${driverId}/assignments/${candidate}`] = null;
      }
    });
    if (currentTourId !== tourId) return;
    updates[`drivers/${driverId}/currentTourId`] = null;
    updates[`drivers/${driverId}/currentTourCode`] = null;
    const authUid = resolveTrimmedString(driver.authUid);
    if (authUid && isValidFirebaseKey(authUid)) {
      updates[`users/${authUid}/driverAssignedTourId`] = null;
      updates[`users/${authUid}/lastUpdated`] = Date.now();
    }
  });
  Object.keys(driverUsers).forEach((authUid) => {
    if (!isValidFirebaseKey(authUid)) return;
    updates[`users/${authUid}/driverAssignedTourId`] = null;
    updates[`users/${authUid}/lastUpdated`] = Date.now();
  });

  Object.entries(contentReports).forEach(([reportId, report = {}]) => {
    if (normalizeTourKeyForComparison(report.tourId) === tourId) {
      updates[`content_reports/${reportId}`] = null;
    }
  });
  Object.entries(globalSafetyAlerts).forEach(([eventId, alert = {}]) => {
    if (normalizeTourKeyForComparison(alert.tourId) === tourId) {
      updates[`globalSafetyAlerts/${eventId}`] = null;
    }
  });

  return updates;
};

/** @type {(...args: any[]) => Promise<any>} */
const getBookingsForTour = async ({ db, tourId, tourCode }) => {
  const bookings = {};
  const candidates = [...new Set([tourId, resolveTrimmedString(tourCode)].filter(Boolean))];
  const snapshots = await Promise.all(candidates.map((candidate) => (
    db.ref('bookings').orderByChild('tourId').equalTo(candidate).once('value')
  )));
  snapshots.forEach((snapshot) => Object.assign(bookings, snapshot.val() || {}));
  return bookings;
};

/** @type {(...args: any[]) => any} */
const resolveReportedPhotoStoragePaths = ({ tourId, photo = {} }) => {
  const prefix = `group_tour_photos/${tourId}/`;
  const paths = [photo.storagePath, photo.viewerStoragePath, photo.thumbnailStoragePath]
    .filter((path) => typeof path === 'string' && path.startsWith(prefix));
  const parsedSource = parseSourcePhotoPath(photo.storagePath);
  if (parsedSource?.visibility === 'group' && parsedSource.tourId === tourId) {
    const variants = buildPhotoVariantPaths(parsedSource);
    paths.push(variants.viewerPath, variants.thumbnailPath);
  }
  return [...new Set(paths)];
};


module.exports = {
  buildTourDeletionUpdates,
  getBookingsForTour,
  resolveReportedPhotoStoragePaths,
};
