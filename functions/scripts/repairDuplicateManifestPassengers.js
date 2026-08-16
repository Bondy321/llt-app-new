#!/usr/bin/env node

const admin = require('firebase-admin');
const { normalizeManifestPassengerRows } = require('../lib/manifestPassengers');

const VALID_STATUSES = new Set(['PENDING', 'BOARDED', 'NO_SHOW']);

const readArg = (name) => {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length).trim() : '';
};

const normalizeTourId = (value) => String(value || '').trim().toUpperCase().replace(/\s+/g, '_');

const dedupePickupPoints = (pickupPoints) => {
  if (!Array.isArray(pickupPoints)) return pickupPoints;
  const seen = new Set();
  return pickupPoints.filter((point) => {
    if (!point || typeof point !== 'object' || Array.isArray(point)) return true;
    const date = String(point.date || '').trim().slice(0, 10);
    const key = [
      String(point.location || '').trim().toLowerCase(),
      String(point.time || '').trim(),
      date,
    ].join('|');
    if (!key.replaceAll('|', '')) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const resolveCanonicalStatuses = (rows, passengerStatus) => {
  if (!Array.isArray(passengerStatus)) return null;
  return rows.map((row) => {
    const statuses = row.sourceIndexes
      .map((index) => passengerStatus[index])
      .filter((status) => VALID_STATUSES.has(status));
    const nonPending = [...new Set(statuses.filter((status) => status !== 'PENDING'))];
    if (nonPending.length > 1) {
      const error = new Error(`Conflicting statuses for passenger indexes ${row.sourceIndexes.join(',')}`);
      error.code = 'AMBIGUOUS_PASSENGER_STATUS';
      throw error;
    }
    return nonPending[0] || statuses[0] || 'PENDING';
  });
};

const deriveParentStatus = (statuses) => {
  if (!Array.isArray(statuses) || statuses.length === 0) return 'PENDING';
  if (statuses.every((status) => status === 'BOARDED')) return 'BOARDED';
  if (statuses.every((status) => status === 'NO_SHOW')) return 'NO_SHOW';
  if (statuses.every((status) => status === 'PENDING')) return 'PENDING';
  return 'PARTIAL';
};

const createRestClient = ({ projectId, accessToken }) => {
  const databaseUrl = `https://${projectId}-default-rtdb.europe-west1.firebasedatabase.app`;
  const request = async (path, { method = 'GET', body, query = '' } = {}) => {
    const response = await fetch(`${databaseUrl}/${path}.json${query}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Goog-User-Project': projectId,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`Realtime Database REST request failed with HTTP ${response.status}`);
    return response.json();
  };
  return {
    readBookings: (tourId) => request('bookings', {
      query: `?orderBy=${encodeURIComponent('"tourId"')}&equalTo=${encodeURIComponent(JSON.stringify(tourId))}`,
    }),
    readManifest: (tourId) => request(`tour_manifests/${encodeURIComponent(tourId)}/bookings`),
    updateRoot: (updates) => request('', { method: 'PATCH', body: updates }),
    serverTimestamp: { '.sv': 'timestamp' },
  };
};

const buildBookingRepairPlan = ({ bookingRef, booking, manifestRecord }) => {
  const { rows, duplicateCount } = normalizeManifestPassengerRows(booking);
  if (duplicateCount === 0) return null;

  const passengerNames = rows.map((row) => row.name);
  const repairedBooking = {
    ...booking,
    passengerNames,
    passengers: passengerNames,
    seatNumbers: rows.map((row) => row.seatNumber ?? 'TBA'),
    ...(Array.isArray(booking.seatLabels)
      ? { seatLabels: rows.map((row) => row.seatLabel || 'TBA') }
      : {}),
    ...(Array.isArray(booking.passengerDetails)
      ? { passengerDetails: rows.map((row) => row.detail).filter(Boolean) }
      : {}),
    ...(Array.isArray(booking.pickupPoints)
      ? { pickupPoints: dedupePickupPoints(booking.pickupPoints) }
      : {}),
  };

  let repairedManifest = manifestRecord || null;
  if (manifestRecord && Array.isArray(manifestRecord.passengerStatus)) {
    const passengerStatus = resolveCanonicalStatuses(rows, manifestRecord.passengerStatus);
    repairedManifest = {
      ...manifestRecord,
      passengerStatus,
      status: deriveParentStatus(passengerStatus),
    };
  }

  return {
    bookingRef,
    duplicateCount,
    originalBooking: booking,
    originalManifest: manifestRecord || null,
    repairedBooking,
    repairedManifest,
  };
};

const run = async () => {
  const projectId = readArg('project');
  const tourId = normalizeTourId(readArg('tour'));
  const shouldApply = process.argv.includes('--apply');
  if (projectId !== 'loch-lomond-travel' || !tourId) {
    throw new Error('Usage: --project=loch-lomond-travel --tour=TOUR_ID [--apply]');
  }

  const accessToken = String(process.env.GOOGLE_OAUTH_ACCESS_TOKEN || '').trim();
  let bookings;
  let manifest;
  let updateRoot;
  let serverTimestamp;
  if (accessToken) {
    const rest = createRestClient({ projectId, accessToken });
    [bookings, manifest] = await Promise.all([rest.readBookings(tourId), rest.readManifest(tourId)]);
    updateRoot = rest.updateRoot;
    serverTimestamp = rest.serverTimestamp;
  } else {
    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId,
        databaseURL: `https://${projectId}-default-rtdb.europe-west1.firebasedatabase.app`,
      });
    }
    const db = admin.database();
    const [bookingsSnapshot, manifestSnapshot] = await Promise.all([
      db.ref('bookings').orderByChild('tourId').equalTo(tourId).once('value'),
      db.ref(`tour_manifests/${tourId}/bookings`).once('value'),
    ]);
    bookings = bookingsSnapshot.val();
    manifest = manifestSnapshot.val();
    updateRoot = (updates) => db.ref().update(updates);
    serverTimestamp = admin.database.ServerValue.TIMESTAMP;
  }
  bookings ||= {};
  manifest ||= {};
  const plans = Object.entries(bookings)
    .map(([bookingRef, booking]) => buildBookingRepairPlan({
      bookingRef,
      booking: booking || {},
      manifestRecord: manifest[bookingRef] || null,
    }))
    .filter(Boolean);

  const duplicateRows = plans.reduce((total, plan) => total + plan.duplicateCount, 0);
  console.log(JSON.stringify({ mode: shouldApply ? 'apply' : 'dry-run', tourId, affectedBookings: plans.length, duplicateRows }, null, 2));
  if (!shouldApply || plans.length === 0) return;

  const backupId = `manifest_dedup_${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
  const updates = {};
  plans.forEach((plan) => {
    updates[`maintenance_backups/${backupId}/${plan.bookingRef}`] = {
      tourId,
      repairedAt: serverTimestamp,
      booking: plan.originalBooking,
      manifest: plan.originalManifest,
    };
    updates[`bookings/${plan.bookingRef}`] = plan.repairedBooking;
    if (plan.repairedManifest) {
      updates[`tour_manifests/${tourId}/bookings/${plan.bookingRef}`] = plan.repairedManifest;
    }
  });
  await updateRoot(updates);
  console.log(JSON.stringify({ applied: true, backupId, affectedBookings: plans.length, duplicateRows }, null, 2));
};

if (require.main === module) {
  run().catch((error) => {
    console.error(error?.code || 'REPAIR_FAILED', error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  buildBookingRepairPlan,
  dedupePickupPoints,
  resolveCanonicalStatuses,
};
