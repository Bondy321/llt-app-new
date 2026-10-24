'use strict';

const { randomUUID } = require('node:crypto');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { normalizeTourKeyForComparison } = require('../../infrastructure/validation/stringNormalization');
const { parseStrictDateOnly, acquireManualSourceRosterLease, releaseManualSourceRosterLease } = require('./manualPassengerBooking');
const { commitTourPublication } = require('./tourPublication');

const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const fields = new Set(['name', 'tourCode', 'days', 'startDate', 'endDate', 'isActive', 'maxParticipants', 'currentParticipants', 'pickupPoints', 'itinerary', 'driver_itinerary']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit, empty = true) => typeof value === 'string' && value.length <= limit && (empty || value.trim().length > 0);
const exact = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const itineraryValid = value => exact(value, ['title', 'days']) && text(value.title, 300)
  && Array.isArray(value.days) && value.days.length <= 100 && value.days.every(day => (
    exact(day, ['day', 'title', 'activities']) && Number.isInteger(day.day) && day.day >= 1 && day.day <= 100
    && text(day.title, 500) && Array.isArray(day.activities) && day.activities.length <= 100
    && day.activities.every(activity => exact(activity, ['description', 'time'])
      && text(activity.description, 10000) && text(activity.time, 100))
  ));

const validateTourIdentity = ({ tourId, merged, existing, values }) => {
  if (!text(merged.name, 300, false) || !text(merged.tourCode, 80, false)
    || normalizeTourKeyForComparison(merged.tourCode) !== tourId
    || (existing && values.tourCode !== undefined && values.tourCode.trim() !== existing.tourCode?.trim())) fail('INVALID_TOUR');
};
const validateTourCapacity = ({ merged, existing }) => {
  if (!Number.isInteger(merged.days) || merged.days < 1 || merged.days > 100 || typeof merged.isActive !== 'boolean'
    || !Number.isInteger(merged.maxParticipants) || merged.maxParticipants < 1 || merged.maxParticipants > 500
    || !Number.isInteger(merged.currentParticipants) || merged.currentParticipants < 0 || merged.currentParticipants > 500) fail('INVALID_INPUT');
  const sourceCounts = ['sold', 'bookedPassengerCount', 'manifestPassengerCount'].map(key => Number(existing?.[key] || 0));
  const sourceCount = Math.max(...sourceCounts, Number(existing?.currentParticipants || 0)) + Number(existing?.manualPassengerCount || 0);
  if (Math.max(sourceCount, merged.currentParticipants) > merged.maxParticipants) fail('TOUR_CAPACITY_EXCEEDED');
};
const validateChangedContent = ({ merged, existing, values }) => {
  if ((!existing || Object.hasOwn(values, 'pickupPoints')) && (!Array.isArray(merged.pickupPoints) || merged.pickupPoints.length > 100 || !merged.pickupPoints.every(point => (
    exact(point, ['location', 'time']) && text(point.location, 1000, false) && text(point.time, 20)
  )))) fail('INVALID_PICKUPS');
  for (const field of ['itinerary', 'driver_itinerary']) {
    // Validate content being changed; source-owned existing itinerary formats are preserved.
    if (values[field] !== undefined && !itineraryValid(values[field])) fail('INVALID_ITINERARY');
  }
};

function validateTourMutation({ tourId, values, existing = null }) {
  if (!isValidFirebaseKey(tourId) || !record(values) || Object.keys(values).some(key => !fields.has(key))
    || Buffer.byteLength(JSON.stringify(values)) > 512 * 1024) fail('INVALID_INPUT');
  const merged = { name: '', tourCode: tourId, days: 1, isActive: true, maxParticipants: 53,
    currentParticipants: 0, pickupPoints: [], ...existing, ...values };
  validateTourIdentity({ tourId, merged, existing, values });
  validateTourCapacity({ merged, existing });
  const start = parseStrictDateOnly(merged.startDate); const end = parseStrictDateOnly(merged.endDate);
  if (!start || !end || end.date < start.date) fail('INVALID_TOUR_DATES');
  validateChangedContent({ merged, existing, values });
  return { ...values, startDate: start.uk, endDate: end.uk, startDateEpochMs: start.date.getTime(), endDateEpochMs: end.date.getTime() };
}

async function applyTourMutation({ db, tourId, mode, values, expectedRevision, owner = randomUUID(), commit = commitTourPublication }) {
  if (!['create', 'update'].includes(mode) || !isValidFirebaseKey(tourId)) fail('INVALID_INPUT');
  if (!(await acquireManualSourceRosterLease({ db, tourId, owner, allowDeleted: mode === 'create' }))) fail('TOUR_BUSY_OR_DELETED');
  try {
    const current = (await db.ref(`tours/${tourId}`).once('value')).val();
    if (mode === 'create' && current) fail('TOUR_EXISTS');
    if (mode === 'update' && !current) fail('TOUR_NOT_FOUND');
    if (mode === 'update' && expectedRevision !== (current.adminMutationRevision || null)) fail('TOUR_CHANGED');
    const changes = validateTourMutation({ tourId, values, existing: current });
    const revision = randomUUID();
    const updates = {};
    if (mode === 'create') {
      updates[`tours/${tourId}`] = { days: 1, isActive: true, maxParticipants: 53, currentParticipants: 0,
        pickupPoints: [], ...changes, adminMutationRevision: revision };
      updates[`sync_roster_control/${tourId}/lifecycle`] = { state: 'active', generation: randomUUID() };
    } else {
      for (const [field, value] of Object.entries(changes)) updates[`tours/${tourId}/${field}`] = value;
      updates[`tours/${tourId}/adminMutationRevision`] = revision;
      if (Object.hasOwn(values, 'isActive') && current.sourceLifecycle) updates[`tours/${tourId}/sourceLifecycle/managedDisable`] = false;
    }
    await commit({ db, tourIds: [tourId], owner, updates });
    return { id: tourId, revision, tour: mode === 'create' ? updates[`tours/${tourId}`]
      : { ...current, ...changes, adminMutationRevision: revision } };
  } finally { await releaseManualSourceRosterLease({ db, tourId, owner }); }
}

module.exports = { validateTourMutation, applyTourMutation };
