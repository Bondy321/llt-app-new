'use strict';

// @ts-check

const { randomUUID } = require('node:crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { verifyRequestAuthUid } = require('../../infrastructure/auth/requestAuth');
const { acquireManualBookingLock, releaseManualBookingLock } = require('../../infrastructure/database/operationLock');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { applyAuthenticatedCors } = require('../../infrastructure/http/adminCors');
const { log } = require('../../infrastructure/logging/safeLogger');
const { checkRateLimit, getRequestClientKey } = require('../../infrastructure/rate-limit/requestRateLimiter');
const { deleteStoragePaths, deleteStoragePrefixes } = require('../../infrastructure/storage/storageDeletion');
const { normalizeTourKeyForComparison, resolveTrimmedString } = require('../../infrastructure/validation/stringNormalization');
const { verifyOperationsAdminAccess } = require('./adminAuthorization');
const {
  buildManualPassengerBookingUpdates, createManualPassengerError, findManualPassengerSeatConflicts,
  normalizeBookingRef, normalizeManualPassengerPayload,
} = require('./manualPassengerBooking');
const { buildTourDeletionUpdates, getBookingsForTour, resolveReportedPhotoStoragePaths } = require('./tourDeletion');

const TOUR_DELETION_LOCK_TTL_MS = 10 * 60 * 1000;

/** @type {Record<string, number>} */
const MANUAL_BOOKING_STATUS_BY_REASON = Object.freeze({
  INVALID_INPUT: 400, INVALID_TOUR: 400, INVALID_BOOKING_REFERENCE: 400, INVALID_EMAIL: 400,
  INVALID_PICKUP_DATE: 400, INVALID_PICKUP_TIME: 400, INVALID_PICKUP_LOCATION: 400,
  INVALID_PASSENGERS: 400, INVALID_PASSENGER_NAME: 400, INVALID_SEAT_NUMBER: 400,
  INVALID_PHONE: 400, DUPLICATE_SEAT_IN_BOOKING: 400, PICKUP_DATE_OUTSIDE_TOUR: 400,
  TOUR_DATES_INVALID: 409, TOUR_IDENTITY_MISMATCH: 409, TOUR_INACTIVE: 409,
  TOUR_NOT_FOUND: 404, BOOKING_REFERENCE_EXISTS: 409, SEAT_ALREADY_ASSIGNED: 409,
  TOUR_CAPACITY_EXCEEDED: 409, CREATE_IN_PROGRESS: 409,
});

/** @type {(...args: any[]) => Promise<any>} */
const authorizeAdminMutation = async ({ req, res, rateLimit }) => {
  const corsAllowed = applyAuthenticatedCors(req, res);
  if (req.method === 'OPTIONS') {
    return {
      allowed: false,
      response: corsAllowed
        ? res.status(204).send('')
        : res.status(403).json({ success: false, reason: 'ORIGIN_NOT_ALLOWED' }),
    };
  }
  if (!corsAllowed) {
    return { allowed: false, response: res.status(403).json({ success: false, reason: 'ORIGIN_NOT_ALLOWED' }) };
  }
  if (req.method !== 'POST') {
    return { allowed: false, response: res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' }) };
  }
  const requestAuth = await verifyRequestAuthUid(req);
  if (!requestAuth.success) {
    return { allowed: false, response: res.status(401).json({ success: false, reason: 'INVALID_CREDENTIALS' }) };
  }
  const db = admin.database();
  if (!(await verifyOperationsAdminAccess({ authUid: String(requestAuth.uid), db }))) {
    return { allowed: false, response: res.status(403).json({ success: false, reason: 'NOT_AUTHORIZED' }) };
  }
  if (rateLimit && !rateLimit(requestAuth.uid)) {
    return { allowed: false, response: res.status(429).json({ success: false, reason: 'TRY_AGAIN_LATER' }) };
  }
  return { allowed: true, authUid: String(requestAuth.uid), db };
};

/** @param {string} bookingRef @param {string} tourId */
const buildManualBookingLockPaths = (bookingRef, tourId) => [
  bookingRef && isValidFirebaseKey(bookingRef) ? `manual_booking_creation_locks/bookings/${bookingRef}` : null,
  tourId && isValidFirebaseKey(tourId) ? `manual_booking_creation_locks/tours/${tourId}` : null,
].filter(/** @returns {value is string} */ (value) => Boolean(value));

/** @type {(...args: any[]) => Promise<void>} */
const acquireRequiredManualBookingLocks = async ({ db, lockPaths, owner, acquiredLocks }) => {
  if (lockPaths.length !== 2) {
    throw createManualPassengerError('INVALID_INPUT', 'Tour and booking reference are required.');
  }
  for (const lockPath of lockPaths) {
    const acquired = await acquireManualBookingLock({ db, path: lockPath, owner, nowMs: Date.now() });
    if (!acquired) {
      throw createManualPassengerError(
        'CREATE_IN_PROGRESS',
        'Another passenger booking is currently being added. Try again shortly.',
      );
    }
    acquiredLocks.push(lockPath);
  }
};

const onRequestWithResult = /** @type {any} */ (onRequest);

const createManualPassengerBooking = onRequestWithResult(
  {
    region: 'europe-west1',
    maxInstances: 10,
  },
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    const clientKey = getRequestClientKey(req);
    const access = await authorizeAdminMutation({
      req,
      res,
      rateLimit: (/** @type {string} */ authUid) => (
        checkRateLimit(`create_manual_passenger_${authUid}_${clientKey}`, 20, 60000)
      ),
    });
    if (!access.allowed) return access.response;
    const { authUid, db } = access;

    const requestedTourId = normalizeTourKeyForComparison(req.body?.tourId);
    const requestedBookingRef = normalizeBookingRef(req.body?.bookingRef);
    const lockOwner = randomUUID();
    const lockPaths = buildManualBookingLockPaths(requestedBookingRef, requestedTourId);
    /** @type {string[]} */
    const acquiredLocks = [];

    try {
      await acquireRequiredManualBookingLocks({ db, lockPaths, owner: lockOwner, acquiredLocks });

      const [
        tourSnapshot,
        bookingSnapshot,
        identitySnapshot,
        manifestSnapshot,
        bookingsByTourSnapshot,
        pickupPointsSnapshot,
      ] = await Promise.all([
        db.ref(`tours/${requestedTourId}`).once('value'),
        db.ref(`bookings/${requestedBookingRef}`).once('value'),
        db.ref(`booking_identities/${requestedBookingRef}`).once('value'),
        db.ref(`tour_manifests/${requestedTourId}/bookings/${requestedBookingRef}`).once('value'),
        db.ref('bookings').orderByChild('tourId').equalTo(requestedTourId).once('value'),
        db.ref(`pickupPoints/${requestedTourId}`).once('value'),
      ]);

      if (!tourSnapshot.exists()) {
        throw createManualPassengerError('TOUR_NOT_FOUND', 'The selected tour no longer exists.');
      }
      if (bookingSnapshot.exists() || identitySnapshot.exists() || manifestSnapshot.exists()) {
        throw createManualPassengerError(
          'BOOKING_REFERENCE_EXISTS',
          'That booking reference is already in use.',
        );
      }

      const tourData = tourSnapshot.val() || {};
      const normalized = normalizeManualPassengerPayload(req.body, tourData);
      const existingTourBookings = bookingsByTourSnapshot.val() || {};
      const seatConflicts = findManualPassengerSeatConflicts(
        existingTourBookings,
        normalized.passengers,
      );
      if (seatConflicts.length > 0) {
        throw createManualPassengerError(
          'SEAT_ALREADY_ASSIGNED',
          `Seat ${seatConflicts.join(', ')} is already assigned on this tour.`,
        );
      }

      const writePlan = buildManualPassengerBookingUpdates({
        normalized,
        actorUid: authUid,
        tourData,
        existingTourBookings,
        existingTopLevelPickupPoints: pickupPointsSnapshot.val() || [],
      });
      await db.ref().update(writePlan.updates);

      log.info('Manual passenger booking created', {
        authUid,
        bookingRef: normalized.bookingRef,
        tourId: normalized.tourId,
        passengerCount: normalized.passengers.length,
      });

      return res.status(201).json({
        success: true,
        bookingRef: normalized.bookingRef,
        tourId: normalized.tourId,
        tourCode: normalized.tourCode,
        email: normalized.email,
        passengerCount: normalized.passengers.length,
      });
    } catch (error) {
      const reason = /** @type {{ code?: string }} */ (error)?.code || 'INTERNAL_ERROR';
      const status = MANUAL_BOOKING_STATUS_BY_REASON[reason] || 500;
      if (status >= 500) {
        log.error('Manual passenger booking creation failed', error, {
          authUid,
          bookingRef: requestedBookingRef,
          tourId: requestedTourId,
        });
      } else {
        log.warn('Manual passenger booking creation rejected', {
          authUid,
          bookingRef: requestedBookingRef,
          tourId: requestedTourId,
          reason,
        });
      }
      return res.status(status).json({ success: false, reason });
    } finally {
      await Promise.all(acquiredLocks.map((path) => releaseManualBookingLock({
        db,
        path,
        owner: lockOwner,
      })));
    }
  },
);

const deleteTourData = onRequestWithResult(
  {
    region: 'europe-west1',
    maxInstances: 5,
    timeoutSeconds: 300,
  },
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    const access = await authorizeAdminMutation({ req, res });
    if (!access.allowed) return access.response;
    const { db } = access;

    const tourId = normalizeTourKeyForComparison(req.body?.tourId);
    if (!tourId || !isValidFirebaseKey(tourId)) {
      return res.status(400).json({ success: false, reason: 'INVALID_TOUR' });
    }

    const lockPath = `tour_deletion_locks/${tourId}`;
    const lockOwner = randomUUID();
    const lockAcquired = await acquireManualBookingLock({
      db,
      path: lockPath,
      owner: lockOwner,
      nowMs: Date.now(),
      ttlMs: TOUR_DELETION_LOCK_TTL_MS,
    });
    if (!lockAcquired) return res.status(409).json({ success: false, reason: 'DELETE_IN_PROGRESS' });

    try {
      const [tourSnapshot, driversSnapshot, driverUsersSnapshot, reportsSnapshot, safetySnapshot] = await Promise.all([
        db.ref(`tours/${tourId}`).once('value'),
        db.ref('drivers').once('value'),
        db.ref('users').orderByChild('driverAssignedTourId').equalTo(tourId).once('value'),
        db.ref('content_reports').once('value'),
        db.ref('globalSafetyAlerts').once('value'),
      ]);
      const tourExisted = tourSnapshot.exists();
      const tour = tourSnapshot.val() || {};
      const bookings = await getBookingsForTour({ db, tourId, tourCode: tour.tourCode || tourId });
      const updates = buildTourDeletionUpdates({
        tourId,
        bookings,
        drivers: driversSnapshot.val() || {},
        driverUsers: driverUsersSnapshot.val() || {},
        contentReports: reportsSnapshot.val() || {},
        globalSafetyAlerts: safetySnapshot.val() || {},
      });
      const deletedStorageObjects = await deleteStoragePrefixes({
        prefixes: [`group_tour_photos/${tourId}/`, `private_tour_photos/${tourId}/`],
      });
      await db.ref().update(updates);

      const summary = {
        bookingsDeleted: Object.keys(bookings).length,
        storageObjectsDeleted: deletedStorageObjects,
        databasePathsDeleted: Object.keys(updates).filter((path) => updates[path] === null).length,
        alreadyDeleted: !tourExisted,
      };
      log.info('Tour deletion completed', { tourId, ...summary });
      return res.status(200).json({ success: true, tourId, alreadyDeleted: !tourExisted, summary });
    } catch (error) {
      log.error('Tour deletion failed', error, { tourId });
      return res.status(500).json({ success: false, reason: 'INTERNAL_ERROR' });
    } finally {
      await releaseManualBookingLock({ db, path: lockPath, owner: lockOwner });
    }
  },
);

const removeReportedPhoto = onRequestWithResult(
  {
    region: 'europe-west1',
    maxInstances: 10,
    timeoutSeconds: 120,
  },
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    const access = await authorizeAdminMutation({ req, res });
    if (!access.allowed) return access.response;
    const { db } = access;

    const reportId = resolveTrimmedString(req.body?.reportId);
    if (!reportId || !isValidFirebaseKey(reportId)) {
      return res.status(400).json({ success: false, reason: 'INVALID_REPORT' });
    }

    try {
      const reportSnapshot = await db.ref(`content_reports/${reportId}`).once('value');
      if (!reportSnapshot.exists()) return res.status(404).json({ success: false, reason: 'INVALID_REPORT' });
      const report = reportSnapshot.val() || {};
      const tourId = normalizeTourKeyForComparison(report.tourId);
      const photoId = resolveTrimmedString(report.contentId);
      if (report.contentType !== 'group_photo' || !tourId || !photoId || !isValidFirebaseKey(photoId)) {
        return res.status(409).json({ success: false, reason: 'UNSUPPORTED_CONTENT' });
      }

      const contentPath = `group_tour_photos/${tourId}/${photoId}`;
      const photoSnapshot = await db.ref(contentPath).once('value');
      const photo = photoSnapshot.val() || {};
      const storagePaths = resolveReportedPhotoStoragePaths({ tourId, photo });
      const deletedStorageObjects = await deleteStoragePaths({ paths: storagePaths });
      const now = Date.now();
      await db.ref().update({
        [contentPath]: null,
        [`content_reports/${reportId}/status`]: 'actioned',
        [`content_reports/${reportId}/updatedAt`]: new Date(now).toISOString(),
        [`content_reports/${reportId}/updatedAtMs`]: now,
        [`content_reports/${reportId}/moderationAction`]: 'photo_and_storage_removed',
      });

      log.info('Reported photo removed', { reportId, tourId, deletedStorageObjects });
      return res.status(200).json({ success: true, contentPath, deletedStorageObjects });
    } catch (error) {
      log.error('Reported photo removal failed', error, { reportId });
      return res.status(500).json({ success: false, reason: 'INTERNAL_ERROR' });
    }
  },
);

module.exports = { createManualPassengerBooking, deleteTourData, removeReportedPhoto };
