'use strict';

const {
  MANIFEST_STATUS,
  buildAssignedDriverCodePayload,
  ensureBookingSchemaConsistency,
  getTourManifest,
  normalizeManifestPassengerRows,
  resolveVerifiedPassengerIdentity,
} = require('./booking/bookingDomain');
const {
  applyManifestUpdateDirect,
  assignDriverToTour,
  updateManifestBooking,
} = require('./booking/manifestService');
const { validateBookingReference } = require('./booking/bookingLoginService');
const {
  ensureTourParticipantCount,
  getDriverItinerary,
  getTourItinerary,
  joinTour,
} = require('./booking/tourMembershipService');

module.exports = {
  MANIFEST_STATUS,
  applyManifestUpdateDirect,
  assignDriverToTour,
  buildAssignedDriverCodePayload,
  ensureBookingSchemaConsistency,
  ensureTourParticipantCount,
  getDriverItinerary,
  getTourItinerary,
  getTourManifest,
  joinTour,
  normalizeManifestPassengerRows,
  resolveVerifiedPassengerIdentity,
  updateManifestBooking,
  validateBookingReference,
};
