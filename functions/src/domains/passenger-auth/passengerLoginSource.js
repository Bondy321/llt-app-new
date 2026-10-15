'use strict';

// @ts-check

const { retireRejectedPassengerSession } = require('../app-sessions/public');
const { normalizeTourKeyForComparison } = require('../../infrastructure/validation/stringNormalization');

const isBookingTourConsistent = (booking, canonicalTourId) => {
  const bookingTourId = normalizeTourKeyForComparison(booking.tourId);
  return Boolean(bookingTourId) && bookingTourId === canonicalTourId;
};

// Runtime contact/count changes do not invalidate login. Source identity and
// publication changes do: an old projection must never appear as a fresh login.
const fingerprintPassengerLoginSource = (context) => {
  const booking = context.bookingSnapshot.val() || {};
  const roster = booking.sourceRoster || {};
  const sync = context.tourData.rosterSync || {};
  return JSON.stringify([
    context.resolvedBookingRef, context.canonicalTourId, context.identity.email?.trim().toLowerCase(),
    booking.tourId, booking.loginEligible, roster.schemaVersion, roster.state, roster.revision,
    roster.scopeEpoch, roster.transferId, context.tourData.isActive,
    sync.state, sync.generation, sync.reportDate,
  ]);
};

const confirmIssuedPassengerSource = async ({
  context, authUid, appSession, appSessionLock, bookingRef, email, networkDimension,
  loadContext, retireSession = retireRejectedPassengerSession,
}) => {
  let refreshed;
  try {
    refreshed = await loadContext({ bookingRef, email, networkDimension });
    if (refreshed.ok && refreshed.resolvedBookingRef === context.resolvedBookingRef
      && refreshed.canonicalTourId === appSession.tourId
      && fingerprintPassengerLoginSource(refreshed) === fingerprintPassengerLoginSource(context)) {
      return refreshed;
    }
  } catch {
    // The source must be verified even if a final read fails transiently.
  }
  await retireSession({ db: context.database, session: { ...appSession, authUid }, appSessionLock });
  return refreshed && !refreshed.ok ? refreshed
    : { ok: false, status: 503, body: { valid: false, reason: 'SOURCE_CHANGED' } };
};

module.exports = { confirmIssuedPassengerSource, fingerprintPassengerLoginSource, isBookingTourConsistent };
