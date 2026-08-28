'use strict';

const DRIVER_LOCATION_PICKUP_SCHEMA_VERSION = 1;
const DRIVER_LOCATION_PICKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DRIVER_LOCATION_PICKUP_MAX_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;

const boundedText = (value, maxLength) => typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
const validTimestamp = (value) => Number.isSafeInteger(value) && value > 0;
const validRevision = (value) => Number.isSafeInteger(value) && value >= 0;
const validCoordinates = (record) => Number.isFinite(record?.latitude)
  && record.latitude >= -90 && record.latitude <= 90
  && Number.isFinite(record?.longitude)
  && record.longitude >= -180 && record.longitude <= 180;

const buildAssignmentOwnedDriverLocationPickup = ({
  driverId,
  tourId,
  assignmentRevision,
  location,
  address,
  updatedBy,
  nowMs = Date.now(),
  tourEndAtMs = null,
} = {}) => {
  const normalizedDriverId = boundedText(driverId, 100);
  const normalizedTourId = boundedText(tourId, 100);
  const latitude = Number(location?.latitude);
  const longitude = Number(location?.longitude);
  if (!normalizedDriverId || !normalizedTourId || !validRevision(assignmentRevision)
    || !validCoordinates({ latitude, longitude }) || !validTimestamp(nowMs)) {
    throw new Error('A valid current driver assignment and pickup location are required');
  }
  const retentionBase = validTimestamp(tourEndAtMs) ? Math.max(nowMs, tourEndAtMs) : nowMs;
  const expiresAtMs = Math.min(
    retentionBase + DRIVER_LOCATION_PICKUP_RETENTION_MS,
    nowMs + DRIVER_LOCATION_PICKUP_MAX_RETENTION_MS,
  );
  const pickup = {
    schemaVersion: DRIVER_LOCATION_PICKUP_SCHEMA_VERSION,
    isSharing: true,
    source: 'manual',
    mode: 'pickup',
    driverId: normalizedDriverId,
    tourId: normalizedTourId,
    assignmentRevision,
    latitude,
    longitude,
    timestamp: nowMs,
    publishedAtMs: nowMs,
    expiresAtMs,
  };
  const accuracy = Number(location?.accuracy);
  if (Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 10_000) pickup.accuracy = accuracy;
  const safeAddress = boundedText(address, 500);
  if (safeAddress) pickup.address = safeAddress;
  const safeUpdatedBy = boundedText(updatedBy, 100);
  if (safeUpdatedBy) pickup.updatedBy = safeUpdatedBy;
  return pickup;
};

const isValidAssignmentOwnedDriverLocationPickup = (record, nowMs = Date.now()) => Boolean(
  record && typeof record === 'object' && !Array.isArray(record)
  && record.schemaVersion === DRIVER_LOCATION_PICKUP_SCHEMA_VERSION
  && record.isSharing === true && record.source === 'manual' && record.mode === 'pickup'
  && boundedText(record.driverId, 100) && boundedText(record.tourId, 100)
  && validRevision(record.assignmentRevision) && validCoordinates(record)
  && validTimestamp(record.timestamp) && validTimestamp(record.publishedAtMs)
  && record.timestamp === record.publishedAtMs
  && validTimestamp(record.expiresAtMs) && record.expiresAtMs > nowMs
  && (!Object.hasOwn(record, 'authUid')) && (!Object.hasOwn(record, 'appSessionId'))
);

const readValue = async (ref) => {
  const snapshot = typeof ref?.get === 'function' ? await ref.get() : await ref.once('value');
  return snapshot?.val?.() ?? null;
};

const hasCurrentPickupAssignmentAuthority = async (database, record, nowMs = Date.now()) => {
  if (!database?.ref || !isValidAssignmentOwnedDriverLocationPickup(record, nowMs)) return false;
  const [driver, tour, assigned] = await Promise.all([
    readValue(database.ref(`drivers/${record.driverId}`)),
    readValue(database.ref(`tours/${record.tourId}`)),
    readValue(database.ref(`tour_manifests/${record.tourId}/assigned_drivers/${record.driverId}`)),
  ]);
  return Boolean(
    driver?.currentTourId === record.tourId
    && tour?.driverId === record.driverId
    && Number(tour?.driverAssignmentRevision || 0) === record.assignmentRevision
    && assigned === true
  );
};

const removeDriverLocationPickupIfAssignmentMatches = async ({
  database, tourId, driverId, assignmentRevision,
} = {}) => {
  if (!database?.ref) throw new Error('A Realtime Database instance is required');
  const normalizedTourId = boundedText(tourId, 100);
  const normalizedDriverId = boundedText(driverId, 100);
  if (!normalizedTourId || !normalizedDriverId || !validRevision(assignmentRevision)) {
    throw new Error('A valid pickup assignment is required');
  }
  const result = await database.ref(`driver_location_pickups/${normalizedTourId}`).transaction((current) => {
    if (!current || current.driverId !== normalizedDriverId
      || current.tourId !== normalizedTourId
      || current.assignmentRevision !== assignmentRevision) return undefined;
    return null;
  }, undefined, false);
  return { removed: result?.committed === true };
};

module.exports = {
  DRIVER_LOCATION_PICKUP_MAX_RETENTION_MS,
  DRIVER_LOCATION_PICKUP_RETENTION_MS,
  DRIVER_LOCATION_PICKUP_SCHEMA_VERSION,
  buildAssignmentOwnedDriverLocationPickup,
  hasCurrentPickupAssignmentAuthority,
  isValidAssignmentOwnedDriverLocationPickup,
  removeDriverLocationPickupIfAssignmentMatches,
};
